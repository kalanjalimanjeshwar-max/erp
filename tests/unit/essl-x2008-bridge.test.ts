import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
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
import { redactSensitiveText } from '../../src/shared/biometric.js';
import { AuthUser } from '../../src/shared/types.js';
import {
  ZKTecoTcpAdapter,
  ZK_CMD,
  buildZkTcpFrame,
  extractZkTcpFrames,
} from '../../bridges/essl-x2008-bridge/src/protocol/zkteco-tcp.adapter.js';
import { CheckpointStore } from '../../bridges/essl-x2008-bridge/src/checkpoint-store.js';
import { BiometricBridgeRunner } from '../../bridges/essl-x2008-bridge/src/bridge-runner.js';
import { BridgeLogger } from '../../bridges/essl-x2008-bridge/src/logger.js';
import { CoreErpApiError, ICoreErpClient } from '../../bridges/essl-x2008-bridge/src/coreerp-client.js';
import { validateTransportUrl } from '../../bridges/essl-x2008-bridge/src/security/dpapi.js';
import { deviceLocalDateTimeToUtcIso } from '../../bridges/essl-x2008-bridge/src/timezone.js';
import { BiometricMappingService } from '../../src/server/services/biometric-mapping.service.js';
import {
  BridgeConfig,
  DeviceAttendanceRecord,
  DeviceInfo,
  IBiometricProtocolAdapter,
} from '../../bridges/essl-x2008-bridge/src/types.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

/**
 * Encodes wall-clock components back into ZKTeco 32-bit packed timestamp for mock wire tests.
 */
function encodeZkTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  return (
    ((year - 2000) * 12 * 31 + (month - 1) * 31 + (day - 1)) * 86400 +
    (hour * 3600 + minute * 60 + second)
  ) >>> 0;
}

/**
 * Builds a 40-byte ZLM60_TFT attendance record wire buffer.
 */
function build40ByteAttRecord(params: {
  uid: number;
  userId: string;
  verifyCode: number;
  inOutCode: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): Buffer {
  const rec = Buffer.alloc(40, 0);
  rec.writeUInt16LE(params.uid, 0);
  rec.write(params.userId, 2, 24, 'ascii');
  rec.writeUInt8(params.verifyCode, 26);
  rec.writeUInt32LE(
    encodeZkTimestamp(params.year, params.month, params.day, params.hour, params.minute, params.second),
    27
  );
  rec.writeUInt8(params.inOutCode, 31);
  return rec;
}

/**
 * Builds a 72-byte ZLM60_TFT user record wire buffer.
 */
function build72ByteUserRecord(params: {
  uid: number;
  enrollmentId: string;
  name: string;
  cardNo?: number;
}): Buffer {
  const rec = Buffer.alloc(72, 0);
  rec.writeUInt16LE(params.uid, 0);
  Buffer.from(params.name, 'ascii').copy(rec, 11);
  if (params.cardNo !== undefined) {
    rec.writeUInt32LE(params.cardNo >>> 0, 35);
  }
  Buffer.from(params.enrollmentId, 'ascii').copy(rec, 48);
  return rec;
}

/**
 * Starts a local TCP server implementing the ZKTeco Standalone Pull TCP wire protocol (port 4370).
 */
async function startMockX2008Server(options: {
  serialNumber?: string;
  platform?: string;
  zkfpVersion?: string;
  requireAuth?: boolean;
  records?: Buffer[];
  userRecords?: Buffer[];
  failGetUsers?: boolean;
  usePrepareData?: boolean;
}): Promise<{
  port: number;
  receivedCommands: number[];
  close: () => Promise<void>;
}> {
  const receivedCommands: number[] = [];
  const sessionId = 0x1234;
  let authenticated = !options.requireAuth;

  const server = net.createServer((socket) => {
    let recv: Buffer = Buffer.alloc(0);
    socket.on('error', () => {});

    socket.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      const { frames, remaining } = extractZkTcpFrames(recv);
      recv = remaining;

      for (const frame of frames) {
        receivedCommands.push(frame.command);

        if (frame.command === ZK_CMD.CONNECT) {
          const replyCmd = options.requireAuth ? ZK_CMD.ACK_UNAUTH : ZK_CMD.ACK_OK;
          socket.write(buildZkTcpFrame(replyCmd, sessionId, frame.replyId));
        } else if (frame.command === ZK_CMD.AUTH) {
          authenticated = true;
          socket.write(buildZkTcpFrame(ZK_CMD.ACK_OK, sessionId, frame.replyId));
        } else if (!authenticated) {
          socket.write(buildZkTcpFrame(ZK_CMD.ACK_UNAUTH, sessionId, frame.replyId));
        } else if (frame.command === ZK_CMD.OPTIONS_RRQ) {
          const key = frame.payload.toString('ascii').replace(/\0+$/, '');
          let val = '';
          if (key === '~SerialNumber') val = `~SerialNumber=${options.serialNumber ?? 'NFZ8252800275'}`;
          else if (key === '~Platform') val = `~Platform=${options.platform ?? 'ZLM60_TFT'}`;
          else if (key === '~ZKFPVersion') val = `~ZKFPVersion=${options.zkfpVersion ?? 'VX10.0'}`;
          else if (key === '~DeviceName') val = '~DeviceName=eSSL X2008';
          else if (key === '~OEMVendor') val = '~OEMVendor=eSSL';
          socket.write(buildZkTcpFrame(ZK_CMD.ACK_OK, sessionId, frame.replyId, Buffer.from(`${val}\0`, 'ascii')));
        } else if (frame.command === ZK_CMD.GET_VERSION) {
          socket.write(buildZkTcpFrame(ZK_CMD.ACK_OK, sessionId, frame.replyId, Buffer.from('Ver 6.60 Feb 2024\0', 'ascii')));
        } else if (frame.command === ZK_CMD.ATTLOG_RRQ) {
          const recs = options.records || [];
          const body = Buffer.concat(recs);
          const payload = Buffer.alloc(4 + body.length);
          payload.writeUInt32LE(body.length, 0);
          body.copy(payload, 4);

          if (options.usePrepareData) {
            const prepHeader = Buffer.alloc(4);
            prepHeader.writeUInt32LE(payload.length, 0);
            socket.write(buildZkTcpFrame(ZK_CMD.PREPARE_DATA, sessionId, frame.replyId, prepHeader));

            // Split into 2 fragmented DATA frames to exercise stream assembly
            const mid = Math.ceil(payload.length / 2);
            socket.write(buildZkTcpFrame(ZK_CMD.DATA, sessionId, frame.replyId, payload.subarray(0, mid)));
            socket.write(buildZkTcpFrame(ZK_CMD.DATA, sessionId, frame.replyId, payload.subarray(mid)));
            socket.write(buildZkTcpFrame(ZK_CMD.ACK_OK, sessionId, frame.replyId));
          } else {
            socket.write(buildZkTcpFrame(ZK_CMD.ACK_DATA, sessionId, frame.replyId, payload));
          }
        } else if (frame.command === ZK_CMD.USERTEMP_RRQ) {
          if (options.failGetUsers) {
            socket.write(buildZkTcpFrame(ZK_CMD.ACK_ERROR, sessionId, frame.replyId));
          } else {
            const uRecs = options.userRecords || [];
            const body = Buffer.concat(uRecs);
            const payload = Buffer.alloc(4 + body.length);
            payload.writeUInt32LE(body.length, 0);
            body.copy(payload, 4);

            if (options.usePrepareData) {
              const prepHeader = Buffer.alloc(4);
              prepHeader.writeUInt32LE(payload.length, 0);
              socket.write(buildZkTcpFrame(ZK_CMD.PREPARE_DATA, sessionId, frame.replyId, prepHeader));
              const mid = Math.ceil(payload.length / 2);
              if (mid > 0) {
                socket.write(buildZkTcpFrame(ZK_CMD.DATA, sessionId, frame.replyId, payload.subarray(0, mid)));
              }
              if (payload.length > mid) {
                socket.write(buildZkTcpFrame(ZK_CMD.DATA, sessionId, frame.replyId, payload.subarray(mid)));
              }
              socket.write(buildZkTcpFrame(ZK_CMD.ACK_OK, sessionId, frame.replyId));
            } else {
              socket.write(buildZkTcpFrame(ZK_CMD.ACK_DATA, sessionId, frame.replyId, payload));
            }
          }
        } else if (frame.command === ZK_CMD.FREE_DATA || frame.command === ZK_CMD.EXIT) {
          socket.write(buildZkTcpFrame(ZK_CMD.ACK_OK, sessionId, frame.replyId));
          if (frame.command === ZK_CMD.EXIT) socket.end();
        } else {
          socket.write(buildZkTcpFrame(ZK_CMD.ACK_ERROR, sessionId, frame.replyId));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;

  return {
    port: address.port,
    receivedCommands,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if (typeof (server as any).closeAllConnections === 'function') {
          (server as any).closeAllConnections();
        }
      }),
  };
}

function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coreerp-x2008-test-'));
  return {
    root,
    dataDir: path.join(root, 'data'),
    logDir: path.join(root, 'logs'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function createInMemoryCompanySettingStore() {
  const store = new Map<string, string>();
  const makeKey = (companyId: string, key: string) => `${companyId}::${key}`;

  const findUniqueSpy = vi
    .spyOn(prisma.companySetting, 'findUnique')
    .mockImplementation((async (args: any) => {
      const k = makeKey(args.where.companyId_key.companyId, args.where.companyId_key.key);
      const val = store.get(k);
      return val === undefined
        ? null
        : ({
            id: k,
            companyId: args.where.companyId_key.companyId,
            key: args.where.companyId_key.key,
            value: val,
          } as any);
    }) as any);

  const upsertSpy = vi
    .spyOn(prisma.companySetting, 'upsert')
    .mockImplementation((async (args: any) => {
      const k = makeKey(args.where.companyId_key.companyId, args.where.companyId_key.key);
      const val = args.update?.value ?? args.create?.value ?? '{}';
      store.set(k, val);
      return {
        id: k,
        companyId: args.where.companyId_key.companyId,
        key: args.where.companyId_key.key,
        value: val,
      } as any;
    }) as any);

  return { store, findUniqueSpy, upsertSpy };
}

describe('eSSL X2008 Biometric LAN Bridge & CoreERP Integration', () => {
  const app = createApp();
  const tempCleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempCleanups.length > 0) {
      tempCleanups.pop()?.();
    }
  });

  describe('1. ZKTeco Standalone Pull TCP Protocol Compatibility (eSSL X2008 / ZLM60_TFT)', () => {
    it('should connect, authenticate, read device info & 40-byte ZLM60_TFT attendance logs cleanly without deleting device logs', async () => {
      const rec1 = build40ByteAttRecord({
        uid: 1,
        userId: 'EMP001',
        verifyCode: 1, // FINGERPRINT
        inOutCode: 0, // CHECK_IN
        year: 2026,
        month: 11,
        day: 15,
        hour: 9,
        minute: 5,
        second: 30,
      });
      const rec2 = build40ByteAttRecord({
        uid: 2,
        userId: 'EMP002',
        verifyCode: 15, // FACE
        inOutCode: 1, // CHECK_OUT
        year: 2026,
        month: 11,
        day: 15,
        hour: 18,
        minute: 15,
        second: 0,
      });

      const mockDevice = await startMockX2008Server({
        serialNumber: 'NFZ8252800275',
        platform: 'ZLM60_TFT',
        zkfpVersion: 'VX10.0',
        requireAuth: true,
        records: [rec1, rec2],
        usePrepareData: true,
      });

      try {
        const adapter = new ZKTecoTcpAdapter();
        await adapter.connect({
          host: '127.0.0.1',
          port: mockDevice.port,
          commKey: 1234,
          timeoutMs: 3000,
        });

        const info = await adapter.getDeviceInfo();
        expect(info.serialNumber).toBe('NFZ8252800275');
        expect(info.platform).toBe('ZLM60_TFT');
        expect(info.fingerprintAlgorithm).toBe('VX10.0');

        const logs = await adapter.getAttendanceLogs();
        expect(logs).toHaveLength(2);
        expect(logs[0].userEnrollmentId).toBe('EMP001');
        expect(logs[0].verifyType).toBe('FINGERPRINT');
        expect(logs[0].inOutMode).toBe('CHECK_IN');
        expect(logs[0].localDateTime).toEqual({
          year: 2026,
          month: 11,
          day: 15,
          hour: 9,
          minute: 5,
          second: 30,
        });
        expect(logs[1].userEnrollmentId).toBe('EMP002');
        expect(logs[1].verifyType).toBe('FACE');
        expect(logs[1].inOutMode).toBe('CHECK_OUT');

        await adapter.disconnect();

        // Read-only invariant: CMD_CLEAR_ATTLOG (15) MUST NEVER be sent
        expect(mockDevice.receivedCommands).not.toContain(15);
        expect(mockDevice.receivedCommands).toContain(ZK_CMD.AUTH);
        expect(mockDevice.receivedCommands).toContain(ZK_CMD.EXIT);
      } finally {
        await mockDevice.close();
      }
    });

    it('should fail explicitly on unreachable TCP host/port without faking success', async () => {
      const adapter = new ZKTecoTcpAdapter();
      await expect(
        adapter.connect({ host: '127.0.0.1', port: 1, timeoutMs: 500 })
      ).rejects.toThrowError(/TCP connection (failed|timed out)/i);
    });
  });

  describe('2. Timezone & Configuration Validation', () => {
    it('should convert device wall-clock Asia/Kolkata timestamps to accurate UTC ISO-8601', () => {
      const utcIso = deviceLocalDateTimeToUtcIso(
        { year: 2026, month: 11, day: 15, hour: 9, minute: 30, second: 0 },
        'Asia/Kolkata'
      );
      expect(utcIso).toBe('2026-11-15T04:00:00.000Z');
    });

    it('should reject invalid terminal configurations (bad IP, port, timezone, insecure remote HTTP)', () => {
      const dirs = makeTempDirs();
      tempCleanups.push(dirs.cleanup);

      expect(() => validateTransportUrl('http://erp.external.example.com', false)).toThrowError(/Insecure CoreERP URL/);
      expect(() => validateTransportUrl('https://erp.external.example.com', false)).not.toThrow();
      expect(() => validateTransportUrl('http://127.0.0.1:3000', false)).not.toThrow();

      const logger = new BridgeLogger({ silentConsole: true });
      const cpStore = new CheckpointStore(dirs.dataDir);
      const dummyClient: ICoreErpClient = {
        sendHeartbeat: vi.fn(),
        submitPunches: vi.fn(),
        syncUsers: vi.fn(),
      };

      const baseCfg: BridgeConfig = {
        coreErpBaseUrl: 'https://erp.company.local',
        allowInsecureHttp: false,
        bridgeHost: 'WIN-BRIDGE-01',
        bridgeVersion: '1.0.0',
        healthHost: '127.0.0.1',
        healthPort: 4379,
        dataDir: dirs.dataDir,
        logDir: dirs.logDir,
        logLevel: 'info',
        batchSize: 100,
        pollIntervalMs: 15000,
        heartbeatIntervalMs: 60000,
        connectTimeoutMs: 2000,
        maxBackoffMs: 120000,
        dpapiStorePath: path.join(dirs.dataDir, 'creds.json'),
        terminals: [
          {
            id: 'bad-port',
            name: 'Bad Port Terminal',
            serialNumber: 'NFZ8252800275',
            ipAddress: '192.168.1.201',
            port: 99999,
            deviceTimezone: 'Asia/Kolkata',
            apiKey: 'bio_live_abc',
          },
        ],
      };

      expect(() => new BiometricBridgeRunner({ config: baseCfg, logger, checkpointStore: cpStore, coreErpClient: dummyClient }))
        .toThrowError(/invalid TCP port/);

      baseCfg.terminals[0].port = 4370;
      baseCfg.terminals[0].deviceTimezone = 'Invalid/Timezone';
      expect(() => new BiometricBridgeRunner({ config: baseCfg, logger, checkpointStore: cpStore, coreErpClient: dummyClient }))
        .toThrowError(/invalid deviceTimezone/);
    });

    it('should reject syncing when physical device serial mismatches registered serial', async () => {
      const dirs = makeTempDirs();
      tempCleanups.push(dirs.cleanup);

      const mockDevice = await startMockX2008Server({
        serialNumber: 'WRONG-SERIAL-999',
        records: [],
      });

      try {
        const runner = new BiometricBridgeRunner({
          config: {
            coreErpBaseUrl: 'http://127.0.0.1:3000',
            allowInsecureHttp: false,
            bridgeHost: 'WIN-BRIDGE-01',
            bridgeVersion: '1.0.0',
            healthHost: '127.0.0.1',
            healthPort: 4379,
            dataDir: dirs.dataDir,
            logDir: dirs.logDir,
            logLevel: 'info',
            batchSize: 100,
            pollIntervalMs: 15000,
            heartbeatIntervalMs: 60000,
            connectTimeoutMs: 2000,
            maxBackoffMs: 120000,
            dpapiStorePath: path.join(dirs.dataDir, 'creds.json'),
            terminals: [
              {
                id: 'x2008-1',
                name: 'eSSL X2008',
                serialNumber: 'NFZ8252800275',
                ipAddress: '127.0.0.1',
                port: mockDevice.port,
                deviceTimezone: 'Asia/Kolkata',
                apiKey: 'bio_live_1234567890abcdef',
              },
            ],
          },
          logger: new BridgeLogger({ silentConsole: true }),
          checkpointStore: new CheckpointStore(dirs.dataDir),
          coreErpClient: {
            sendHeartbeat: vi.fn(),
            submitPunches: vi.fn(),
            syncUsers: vi.fn(),
          },
        });

        await expect(runner.syncTerminalOnce('x2008-1')).rejects.toThrowError(/Hardware serial mismatch/);
      } finally {
        await mockDevice.close();
      }
    });
  });

  describe('3. Heartbeat Authentication, Serial Guard & Backend Telemetry', () => {
    it('should enforce X-Device-Serial matching in requireDeviceAuth and reject mismatched serial with 403', async () => {
      const { store, upsertSpy } = createInMemoryCompanySettingStore();
      const plainKey = 'bio_live_valid_secret_key_000111222333444';
      const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue({
        id: 'term-x2008-id',
        companyId: 'company-1',
        deviceSerialNumber: 'NFZ8252800275',
        name: 'X2008 Gate',
        apiKeyHash: keyHash,
        isActive: true,
        status: 'OFFLINE',
      } as any);

      const mismatchRes = await request(app)
        .post('/api/biometric/heartbeat')
        .set('X-Device-Api-Key', plainKey)
        .set('X-Device-Serial', 'OTHER-SERIAL')
        .send({ firmwareVersion: 'Ver 6.60' });

      expect(mismatchRes.status).toBe(403);
      expect(mismatchRes.body.error.code).toBe('DEVICE_SERIAL_MISMATCH');

      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValueOnce({} as any);
      const okRes = await request(app)
        .post('/api/biometric/heartbeat')
        .set('X-Device-Api-Key', plainKey)
        .set('X-Device-Serial', 'NFZ8252800275')
        .send({
          firmwareVersion: 'Ver 6.60',
          platform: 'ZLM60_TFT',
          fingerprintAlgorithm: 'VX10.0',
          bridgeConnected: true,
          bridgeHost: '192.168.1.16',
          bridgeVersion: '1.0.0',
        });

      expect(okRes.status).toBe(200);
      expect(okRes.body.success).toBe(true);
      expect(okRes.body.status).toBe('ONLINE');
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const savedTelemetry = JSON.parse(store.get('company-1::BIOMETRIC_BRIDGE_TELEMETRY_V1') || '{}');
      expect(savedTelemetry['term-x2008-id']?.bridgeHost).toBe('192.168.1.16');
    });

    it('should test terminal connection honestly and queue per-terminal sync via authenticated admin endpoints', async () => {
      const { store } = createInMemoryCompanySettingStore();
      const adminUser: AuthUser = {
        id: 'u-admin',
        userId: 'u-admin',
        companyId: 'comp-1',
        email: 'admin@namma.local',
        fullName: 'Admin User',
        role: 'ADMIN',
        isActive: true,
        tokenVersion: 1,
      };
      const token = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({ ...adminUser, role: 'ADMIN' } as any);
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null as any);
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue({
        id: 'term-x2008-1',
        companyId: 'comp-1',
        deviceSerialNumber: 'NFZ8252800275',
        name: 'Main X2008',
        terminalModel: 'eSSL-X2008',
        ipAddress: '127.0.0.1',
        port: 1, // Unreachable port, and no fresh bridge heartbeat
        isActive: true,
        status: 'OFFLINE',
        lastHeartbeatAt: null,
        lastSyncAt: null,
        firmwareVersion: null,
        apiKeyPrefix: 'bio_live_123',
        registeredByUserId: 'u-admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const testRes = await request(app)
        .post('/api/biometric/devices/term-x2008-1/test-connection')
        .set('Authorization', `Bearer ${token}`);

      expect(testRes.status).toBe(200);
      expect(testRes.body.success).toBe(false);
      expect(testRes.body.status).toBe('UNREACHABLE');

      const telemetryAfterTest = JSON.parse(store.get('comp-1::BIOMETRIC_BRIDGE_TELEMETRY_V1') || '{}');
      expect(telemetryAfterTest['term-x2008-1']?.lastTestConnectionStatus).toBe('UNREACHABLE');

      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValueOnce({
          success: true,
          totalEvaluated: 0,
          processed: 0,
          ignored: 0,
          errors: 0,
          results: [],
        });

      const syncRes = await request(app)
        .post('/api/biometric/devices/term-x2008-1/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(syncRes.status).toBe(200);
      expect(syncRes.body.success).toBe(true);
      expect(syncRes.body.bridgeSyncQueued).toBe(true);
      expect(syncRes.body.syncRequestedAt).toBeTruthy();
      expect(reconcileSpy).toHaveBeenCalledWith(
        'comp-1',
        expect.objectContaining({ terminalId: 'term-x2008-1' }),
        'u-admin',
        expect.any(String)
      );

      const telemetryAfterSync = JSON.parse(store.get('comp-1::BIOMETRIC_BRIDGE_TELEMETRY_V1') || '{}');
      expect(telemetryAfterSync['term-x2008-1']?.syncRequestedAt).toBe(syncRes.body.syncRequestedAt);
    });

    it('reports BRIDGE_MANAGED (without faking TCP_REACHABLE) only when fresh bridge telemetry exists for an unreachable LAN terminal', async () => {
      const { store } = createInMemoryCompanySettingStore();
      const adminUser: AuthUser = {
        id: 'u-admin',
        userId: 'u-admin',
        companyId: 'comp-1',
        email: 'admin@namma.local',
        fullName: 'Admin User',
        role: 'ADMIN',
        isActive: true,
        tokenVersion: 1,
      };
      const token = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });

      const freshHeartbeatAt = new Date().toISOString();
      store.set(
        'comp-1::BIOMETRIC_BRIDGE_TELEMETRY_V1',
        JSON.stringify({
          'term-x2008-lan': {
            bridgeConnected: true,
            bridgeHost: 'WIN-RECEPTION-PC',
            lastBridgeHeartbeatAt: freshHeartbeatAt,
          },
        })
      );

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({ ...adminUser } as any);
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null as any);
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue({
        id: 'term-x2008-lan',
        companyId: 'comp-1',
        deviceSerialNumber: 'NFZ8252800275',
        name: 'LAN Gate X2008',
        terminalModel: 'eSSL-X2008',
        ipAddress: '127.0.0.1',
        port: 1, // Direct TCP from server unreachable; bridge telemetry is fresh
        isActive: true,
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
        lastSyncAt: null,
        firmwareVersion: 'Ver 6.60',
        apiKeyPrefix: 'bio_live_123',
        registeredByUserId: 'u-admin',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const res = await request(app)
        .post('/api/biometric/devices/term-x2008-lan/test-connection')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('BRIDGE_MANAGED');
      expect(res.body.latencyMs).toBeNull();
      expect(res.body.message).toMatch(/WIN-RECEPTION-PC/);
    });
  });

  describe('4. Deduplication, Server Restart Recovery, Checkpoint Persistence, Backoff & Multi-Device Isolation', () => {
    it('should prevent duplicate uploads across repeated polls and persist checkpoints across bridge restarts', async () => {
      const dirs = makeTempDirs();
      tempCleanups.push(dirs.cleanup);

      const punch1: DeviceAttendanceRecord = {
        uid: 10,
        userEnrollmentId: 'E101',
        localDateTime: { year: 2026, month: 11, day: 15, hour: 9, minute: 0, second: 0 },
        verifyCode: 1,
        verifyType: 'FINGERPRINT',
        inOutCode: 0,
        inOutMode: 'CHECK_IN',
        workCode: 0,
        recordSequence: 0,
      };
      const punch2: DeviceAttendanceRecord = {
        uid: 10,
        userEnrollmentId: 'E101',
        localDateTime: { year: 2026, month: 11, day: 15, hour: 18, minute: 0, second: 0 },
        verifyCode: 15,
        verifyType: 'FACE',
        inOutCode: 1,
        inOutMode: 'CHECK_OUT',
        workCode: 0,
        recordSequence: 1,
      };

      let deviceBuffer = [punch1];
      const submittedBatches: any[] = [];

      const mockAdapterFactory = (): IBiometricProtocolAdapter => ({
        protocolName: 'mock-x2008',
        connect: vi.fn().mockResolvedValue(undefined),
        getDeviceInfo: vi.fn().mockResolvedValue({
          serialNumber: 'NFZ8252800275',
          platform: 'ZLM60_TFT',
          fingerprintAlgorithm: 'VX10.0',
          firmwareVersion: 'Ver 6.60',
          deviceName: 'eSSL X2008',
          oemVendor: 'eSSL',
        } satisfies DeviceInfo),
        getAttendanceLogs: vi.fn().mockImplementation(async () => [...deviceBuffer]),
        disconnect: vi.fn().mockResolvedValue(undefined),
      });

      const mockCoreErpClient: ICoreErpClient = {
        sendHeartbeat: vi.fn().mockResolvedValue({
          success: true,
          serverTime: new Date().toISOString(),
          terminalId: 'term-1',
          terminalName: 'X2008',
          status: 'ONLINE',
        }),
        submitPunches: vi.fn().mockImplementation(async (_k, _sn, punches) => {
          submittedBatches.push(punches);
          return {
            success: true,
            totalReceived: punches.length,
            inserted: punches.length,
            duplicates: 0,
            unmappedEmployees: 0,
            terminalId: 'term-1',
            terminalName: 'X2008',
          };
        }),
        syncUsers: vi.fn().mockResolvedValue({
          success: true,
          terminalId: 'term-1',
          terminalName: 'X2008',
          discoveredCount: 0,
          syncedCount: 0,
          syncedAt: new Date().toISOString(),
        }),
      };

      const makeConfig = (): BridgeConfig => ({
        coreErpBaseUrl: 'https://erp.company.local',
        allowInsecureHttp: false,
        bridgeHost: '192.168.1.16',
        bridgeVersion: '1.0.0',
        healthHost: '127.0.0.1',
        healthPort: 4379,
        dataDir: dirs.dataDir,
        logDir: dirs.logDir,
        logLevel: 'info',
        batchSize: 100,
        pollIntervalMs: 15000,
        heartbeatIntervalMs: 60000,
        connectTimeoutMs: 2000,
        maxBackoffMs: 120000,
        dpapiStorePath: path.join(dirs.dataDir, 'creds.json'),
        terminals: [
          {
            id: 'x2008-main',
            name: 'X2008 Main',
            serialNumber: 'NFZ8252800275',
            ipAddress: '192.168.1.201',
            port: 4370,
            deviceTimezone: 'Asia/Kolkata',
            apiKey: 'bio_live_secret_1111222233334444',
          },
        ],
      });

      // Run 1: Sync initial punch1
      const runner1 = new BiometricBridgeRunner({
        config: makeConfig(),
        logger: new BridgeLogger({ silentConsole: true }),
        checkpointStore: new CheckpointStore(dirs.dataDir),
        coreErpClient: mockCoreErpClient,
        adapterFactory: mockAdapterFactory,
      });

      const res1 = await runner1.syncTerminalOnce('x2008-main');
      expect(res1.uploadedCount).toBe(1);
      expect(submittedBatches).toHaveLength(1);
      expect(submittedBatches[0][0].punchTime).toBe('2026-11-15T03:30:00.000Z');

      // Re-poll with identical buffer -> 0 uploaded (deduped locally)
      const resDup = await runner1.syncTerminalOnce('x2008-main');
      expect(resDup.newlyQueuedCount).toBe(0);
      expect(submittedBatches).toHaveLength(1);
      await runner1.stop();

      // Bridge Restart: Instantiate fresh CheckpointStore & Runner from disk, add punch2 alongside punch1
      deviceBuffer = [punch1, punch2];
      const runner2 = new BiometricBridgeRunner({
        config: makeConfig(),
        logger: new BridgeLogger({ silentConsole: true }),
        checkpointStore: new CheckpointStore(dirs.dataDir),
        coreErpClient: mockCoreErpClient,
        adapterFactory: mockAdapterFactory,
      });

      const resAfterRestart = await runner2.syncTerminalOnce('x2008-main');
      expect(resAfterRestart.pulledCount).toBe(2);
      expect(resAfterRestart.newlyQueuedCount).toBe(1);
      expect(resAfterRestart.uploadedCount).toBe(1);
      expect(submittedBatches).toHaveLength(2);
      expect(submittedBatches[1][0].inOutMode).toBe('CHECK_OUT');
    });

    it('should retain queued punches during CoreERP server outage/restart and upload cleanly on recovery', async () => {
      const dirs = makeTempDirs();
      tempCleanups.push(dirs.cleanup);

      const punch: DeviceAttendanceRecord = {
        uid: 5,
        userEnrollmentId: 'E205',
        localDateTime: { year: 2026, month: 11, day: 15, hour: 10, minute: 0, second: 0 },
        verifyCode: 1,
        verifyType: 'FINGERPRINT',
        inOutCode: 0,
        inOutMode: 'CHECK_IN',
        workCode: 0,
        recordSequence: 0,
      };

      let serverDown = true;
      const uploaded: any[] = [];

      const runner = new BiometricBridgeRunner({
        config: {
          coreErpBaseUrl: 'https://erp.company.local',
          allowInsecureHttp: false,
          bridgeHost: '192.168.1.16',
          bridgeVersion: '1.0.0',
          healthHost: '127.0.0.1',
          healthPort: 4379,
          dataDir: dirs.dataDir,
          logDir: dirs.logDir,
          logLevel: 'info',
          batchSize: 100,
          pollIntervalMs: 1000,
          heartbeatIntervalMs: 60000,
          connectTimeoutMs: 2000,
          maxBackoffMs: 16000,
          dpapiStorePath: path.join(dirs.dataDir, 'creds.json'),
          terminals: [
            {
              id: 'x2008-main',
              name: 'X2008 Main',
              serialNumber: 'NFZ8252800275',
              ipAddress: '192.168.1.201',
              port: 4370,
              deviceTimezone: 'Asia/Kolkata',
              apiKey: 'bio_live_secret_recovery_999999999999',
            },
          ],
        },
        logger: new BridgeLogger({ silentConsole: true }),
        checkpointStore: new CheckpointStore(dirs.dataDir),
        coreErpClient: {
          sendHeartbeat: vi.fn(),
          submitPunches: vi.fn().mockImplementation(async (_k, _sn, batch) => {
            if (serverDown) {
              throw new CoreErpApiError('503 Service Restarting', 503, 'HTTP_503');
            }
            uploaded.push(...batch);
            return {
              success: true,
              totalReceived: batch.length,
              inserted: batch.length,
              duplicates: 0,
              unmappedEmployees: 0,
              terminalId: 'term-1',
              terminalName: 'X2008',
            };
          }),
          syncUsers: vi.fn().mockResolvedValue({
            success: true,
            terminalId: 'term-1',
            terminalName: 'X2008',
            discoveredCount: 0,
            syncedCount: 0,
            syncedAt: new Date().toISOString(),
          }),
        },
        adapterFactory: () => ({
          protocolName: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          getDeviceInfo: vi.fn().mockResolvedValue({
            serialNumber: 'NFZ8252800275',
            platform: 'ZLM60_TFT',
            fingerprintAlgorithm: 'VX10.0',
            firmwareVersion: '6.60',
            deviceName: 'eSSL X2008',
            oemVendor: 'eSSL',
          }),
          getAttendanceLogs: vi.fn().mockResolvedValue([punch]),
          disconnect: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // Attempt 1 while CoreERP server is down
      await expect(runner.syncTerminalOnce('x2008-main')).rejects.toThrowError(/503 Service Restarting/);

      // Verify punch persisted locally in pendingQueue on disk
      const reloadedStore = new CheckpointStore(dirs.dataDir);
      expect(reloadedStore.getTerminal('x2008-main', 'NFZ8252800275').pendingQueue).toHaveLength(1);

      // Verify exponential backoff bounds
      expect(runner.computeBackoffDelayMs(1, 1000)).toBeGreaterThanOrEqual(1700);
      expect(runner.computeBackoffDelayMs(5, 1000)).toBeLessThanOrEqual(16000);

      // Server restarts & recovers
      serverDown = false;
      const recovery = await runner.syncTerminalOnce('x2008-main');
      expect(recovery.uploadedCount).toBe(1);
      expect(recovery.remainingQueueCount).toBe(0);
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].userEnrollmentId).toBe('E205');
    });

    it('should isolate multiple terminals and never leak API keys in logs on 401 rejection', async () => {
      const dirs = makeTempDirs();
      tempCleanups.push(dirs.cleanup);

      const secretA = 'bio_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const secretB = 'bio_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const logger = new BridgeLogger({
        level: 'debug',
        logDir: dirs.logDir,
        fileName: 'bridge-test.log',
        silentConsole: true,
      });

      const runner = new BiometricBridgeRunner({
        config: {
          coreErpBaseUrl: 'https://erp.company.local',
          allowInsecureHttp: false,
          bridgeHost: '192.168.1.16',
          bridgeVersion: '1.0.0',
          healthHost: '127.0.0.1',
          healthPort: 4379,
          dataDir: dirs.dataDir,
          logDir: dirs.logDir,
          logLevel: 'debug',
          batchSize: 100,
          pollIntervalMs: 15000,
          heartbeatIntervalMs: 60000,
          connectTimeoutMs: 2000,
          maxBackoffMs: 120000,
          dpapiStorePath: path.join(dirs.dataDir, 'creds.json'),
          terminals: [
            {
              id: 'term-a',
              name: 'Terminal A (Bad Key)',
              serialNumber: 'SN-A-001',
              ipAddress: '192.168.1.201',
              port: 4370,
              deviceTimezone: 'Asia/Kolkata',
              apiKey: secretA,
            },
            {
              id: 'term-b',
              name: 'Terminal B (Healthy)',
              serialNumber: 'SN-B-002',
              ipAddress: '192.168.1.202',
              port: 4370,
              deviceTimezone: 'Asia/Kolkata',
              apiKey: secretB,
            },
          ],
        },
        logger,
        checkpointStore: new CheckpointStore(dirs.dataDir),
        coreErpClient: {
          sendHeartbeat: vi.fn().mockImplementation(async (apiKey) => {
            if (apiKey === secretA) {
              throw new CoreErpApiError(`Rejected token ${secretA}`, 401, 'INVALID_DEVICE_CREDENTIALS');
            }
            return {
              success: true,
              serverTime: new Date().toISOString(),
              terminalId: 'term-b',
              terminalName: 'Terminal B',
              status: 'ONLINE',
            };
          }),
          submitPunches: vi.fn().mockResolvedValue({
            success: true,
            totalReceived: 1,
            inserted: 1,
            duplicates: 0,
            unmappedEmployees: 0,
            terminalId: 'term-b',
            terminalName: 'Terminal B',
          }),
          syncUsers: vi.fn().mockResolvedValue({
            success: true,
            terminalId: 'term-b',
            terminalName: 'Terminal B',
            discoveredCount: 0,
            syncedCount: 0,
            syncedAt: new Date().toISOString(),
          }),
        },
        adapterFactory: (term) => ({
          protocolName: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          getDeviceInfo: vi.fn().mockResolvedValue({
            serialNumber: term.serialNumber,
            platform: 'ZLM60_TFT',
            fingerprintAlgorithm: 'VX10.0',
            firmwareVersion: '6.60',
            deviceName: term.name,
            oemVendor: 'eSSL',
          }),
          getAttendanceLogs: vi.fn().mockResolvedValue([
            {
              uid: 1,
              userEnrollmentId: 'E777',
              localDateTime: { year: 2026, month: 11, day: 15, hour: 9, minute: 0, second: 0 },
              verifyCode: 1,
              verifyType: 'FINGERPRINT',
              inOutCode: 0,
              inOutMode: 'CHECK_IN',
              workCode: 0,
              recordSequence: 0,
            },
          ]),
          disconnect: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const hbA = await runner.sendTerminalHeartbeat('term-a');
      const hbB = await runner.sendTerminalHeartbeat('term-b');
      const syncB = await runner.syncTerminalOnce('term-b');

      expect(hbA).toBe(false);
      expect(hbB).toBe(true);
      expect(syncB.uploadedCount).toBe(1);

      const snap = runner.getStatusSnapshot();
      const statusA = snap.terminals.find((t) => t.id === 'term-a')!;
      const statusB = snap.terminals.find((t) => t.id === 'term-b')!;
      expect(statusA.authError).toBe(true);
      expect(statusB.authError).toBe(false);
      expect(statusB.bridgeConnected).toBe(true);

      // Verify raw secrets never appear in log files or redaction helper output
      const logContent = fs.readFileSync(path.join(dirs.logDir, 'bridge-test.log'), 'utf8');
      expect(logContent).not.toContain(secretA);
      expect(logContent).not.toContain(secretB);
      expect(redactSensitiveText(`Key=${secretA}`)).not.toContain(secretA);
    });
  });

  describe('5. Unmapped Employee Handling & Attendance Safety', () => {
    it('should ingest unmapped employee punch and mark ERROR during reconciliation without corrupting attendance', async () => {
      const { store, findUniqueSpy } = createInMemoryCompanySettingStore();

      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]);

      const createManySpy = vi.fn().mockResolvedValue({ count: 1 });
      const terminalUpdateSpy = vi.fn().mockResolvedValue({});
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) =>
        cb({
          rawPunchLog: { createMany: createManySpy },
          biometricTerminal: { update: terminalUpdateSpy },
        })
      );

      const ingestRes = await BiometricService.ingestPunches(
        {
          id: 'term-1',
          companyId: 'comp-1',
          name: 'eSSL X2008',
          deviceSerialNumber: 'NFZ8252800275',
          registeredByUserId: 'u-1',
        },
        {
          deviceSerialNumber: 'NFZ8252800275',
          punches: [
            {
              devicePunchId: 'NFZ8252800275:UNMAPPED99:2026-11-15T09:00:00:CHECK_IN',
              userEnrollmentId: 'UNMAPPED99',
              punchTime: '2026-11-15T03:30:00.000Z',
              verifyType: 'FINGERPRINT',
              inOutMode: 'CHECK_IN',
            },
          ],
        }
      );

      expect(ingestRes.inserted).toBe(1);
      expect(ingestRes.unmappedEmployees).toBe(1);
      expect(createManySpy).toHaveBeenCalledTimes(1);
      expect(terminalUpdateSpy).toHaveBeenCalledTimes(1);

      const savedTelemetry = JSON.parse(store.get('comp-1::BIOMETRIC_BRIDGE_TELEMETRY_V1') || '{}');
      expect(savedTelemetry['term-1']?.lastProcessedPunchCount).toBe(1);

      const rawPunchUpdate = vi.fn().mockResolvedValue({});
      const attendanceCreate = vi.fn();
      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) =>
        cb({
          companySetting: { findUnique: findUniqueSpy },
          rawPunchLog: {
            findUnique: vi.fn().mockResolvedValue({
              id: 'raw-1',
              companyId: 'comp-1',
              terminalId: 'term-1',
              userEnrollmentId: 'UNMAPPED99',
              punchTime: new Date('2026-11-15T03:30:00.000Z'),
              inOutMode: 'CHECK_IN',
              syncStatus: 'PENDING',
              matchedEmployee: null,
              company: { id: 'comp-1', timezone: 'Asia/Kolkata' },
              terminal: { id: 'term-1', name: 'eSSL X2008', location: 'Main' },
            }),
            update: rawPunchUpdate,
          },
          employee: {
            findUnique: vi.fn().mockResolvedValue(null),
            findFirst: vi.fn().mockResolvedValue(null),
          },
          attendance: { create: attendanceCreate },
        })
      );

      const recRes = await PunchReconciliationService.reconcilePunch('raw-1');
      expect(recRes.status).toBe('ERROR');
      expect(recRes.message).toMatch(/Unmapped biometric enrollment ID/);
      expect(rawPunchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'raw-1' },
          data: expect.objectContaining({ syncStatus: 'ERROR' }),
        })
      );
      expect(attendanceCreate).not.toHaveBeenCalled();
    });

    it('keeps terminal & tenant isolation when reconciling unmapped punch alongside mappings on other terminals or companies', async () => {
      const { store, findUniqueSpy } = createInMemoryCompanySettingStore();

      // Seed active mappings in comp-1 on a DIFFERENT terminal ('term-other') and inactive mapping on 'term-1',
      // plus an active mapping on 'term-1' belonging to a DIFFERENT company ('comp-2').
      store.set(
        'comp-1::BIOMETRIC_EMPLOYEE_MAPPINGS_V1',
        JSON.stringify([
          {
            id: 'map-other-term',
            companyId: 'comp-1',
            employeeId: 'emp-1',
            terminalId: 'term-other',
            enrollmentId: 'UNMAPPED99',
            isActive: true,
            source: 'EXPLICIT',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          },
          {
            id: 'map-inactive',
            companyId: 'comp-1',
            employeeId: 'emp-2',
            terminalId: 'term-1',
            enrollmentId: 'UNMAPPED99',
            isActive: false,
            source: 'EXPLICIT',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          },
        ])
      );
      store.set(
        'comp-2::BIOMETRIC_EMPLOYEE_MAPPINGS_V1',
        JSON.stringify([
          {
            id: 'map-comp-2',
            companyId: 'comp-2',
            employeeId: 'emp-comp2',
            terminalId: 'term-1',
            enrollmentId: 'UNMAPPED99',
            isActive: true,
            source: 'EXPLICIT',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          },
        ])
      );

      const rawPunchUpdate = vi.fn().mockResolvedValue({});
      const attendanceCreate = vi.fn();
      const employeeFindUnique = vi.fn();

      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) =>
        cb({
          companySetting: { findUnique: findUniqueSpy },
          rawPunchLog: {
            findUnique: vi.fn().mockResolvedValue({
              id: 'raw-isolated-1',
              companyId: 'comp-1',
              terminalId: 'term-1',
              userEnrollmentId: 'UNMAPPED99',
              punchTime: new Date('2026-11-15T03:30:00.000Z'),
              inOutMode: 'CHECK_IN',
              syncStatus: 'PENDING',
              matchedEmployee: null,
              company: { id: 'comp-1', timezone: 'Asia/Kolkata' },
              terminal: { id: 'term-1', name: 'eSSL X2008', location: 'Main' },
            }),
            update: rawPunchUpdate,
          },
          employee: {
            findUnique: employeeFindUnique,
            findFirst: vi.fn().mockResolvedValue(null),
          },
          attendance: { create: attendanceCreate },
        })
      );

      const recRes = await PunchReconciliationService.reconcilePunch('raw-isolated-1');
      expect(recRes.status).toBe('ERROR');
      expect(recRes.matchedEmployeeId).toBeNull();
      expect(employeeFindUnique).not.toHaveBeenCalled();
      expect(attendanceCreate).not.toHaveBeenCalled();
      expect(rawPunchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'raw-isolated-1' },
          data: expect.objectContaining({
            syncStatus: 'ERROR',
            errorMessage: expect.stringContaining('UNMAPPED99'),
          }),
        })
      );
    });
  });

  describe('6. Hardware User Synchronization, Telemetry & Error Reporting', () => {
    it('reads real enrolled users over ZKTeco TCP protocol, distinguishes valid empty user list, and throws on ACK_ERROR', async () => {
      const user101 = build72ByteUserRecord({
        uid: 1,
        enrollmentId: '101',
        name: 'Karthik Rao',
        cardNo: 551122,
      });
      const user102 = build72ByteUserRecord({
        uid: 2,
        enrollmentId: '102',
        name: 'Meera Nair',
      });

      const mockWithUsers = await startMockX2008Server({
        serialNumber: 'NFZ8252800275',
        userRecords: [user101, user102],
        usePrepareData: true,
      });

      try {
        const adapter = new ZKTecoTcpAdapter();
        await adapter.connect({ host: '127.0.0.1', port: mockWithUsers.port, timeoutMs: 3000 });
        const users = await adapter.getUsers();
        await adapter.disconnect();

        expect(users).toEqual([
          { uid: 1, enrollmentId: '101', name: 'Karthik Rao', cardNo: '551122' },
          { uid: 2, enrollmentId: '102', name: 'Meera Nair', cardNo: null },
        ]);
      } finally {
        await mockWithUsers.close();
      }

      const mockEmpty = await startMockX2008Server({
        serialNumber: 'NFZ8252800275',
        userRecords: [],
      });
      try {
        const adapter = new ZKTecoTcpAdapter();
        await adapter.connect({ host: '127.0.0.1', port: mockEmpty.port, timeoutMs: 3000 });
        const users = await adapter.getUsers();
        await adapter.disconnect();
        expect(users).toEqual([]);
      } finally {
        await mockEmpty.close();
      }

      const mockError = await startMockX2008Server({
        serialNumber: 'NFZ8252800275',
        failGetUsers: true,
      });
      try {
        const adapter = new ZKTecoTcpAdapter();
        await adapter.connect({ host: '127.0.0.1', port: mockError.port, timeoutMs: 3000 });
        try {
          await expect(adapter.getUsers()).rejects.toThrowError(/CMD_ACK_ERROR on CMD_USERTEMP_RRQ/i);
        } finally {
          await adapter.disconnect();
        }
      } finally {
        await mockError.close();
      }
    });

    it('uploads real deviceUsers via syncTerminalUsersOnce and logs explicit failures without blocking punch polling', async () => {
      const dirs = makeTempDirs();
      tempCleanups.push(dirs.cleanup);

      const secret = 'bio_live_usersync_secret_1234567890abcdef';
      const logger = new BridgeLogger({
        level: 'debug',
        logDir: dirs.logDir,
        fileName: 'user-sync-test.log',
        silentConsole: true,
      });

      const realUsers = [
        { uid: 1, enrollmentId: '101', name: 'Karthik Rao', cardNo: '445566' },
      ];
      let getUsersShouldFail = false;
      let syncUsersShouldFail = false;
      const syncedPayloads: any[] = [];
      const submittedPunches: any[] = [];

      const runner = new BiometricBridgeRunner({
        config: {
          coreErpBaseUrl: 'https://erp.company.local',
          allowInsecureHttp: false,
          bridgeHost: '192.168.1.16',
          bridgeVersion: '1.0.0',
          healthHost: '127.0.0.1',
          healthPort: 4379,
          dataDir: dirs.dataDir,
          logDir: dirs.logDir,
          logLevel: 'debug',
          batchSize: 100,
          pollIntervalMs: 15000,
          heartbeatIntervalMs: 60000,
          connectTimeoutMs: 2000,
          maxBackoffMs: 120000,
          dpapiStorePath: path.join(dirs.dataDir, 'creds.json'),
          terminals: [
            {
              id: 'x2008-main',
              name: 'X2008 Main',
              serialNumber: 'NFZ8252800275',
              ipAddress: '192.168.1.201',
              port: 4370,
              deviceTimezone: 'Asia/Kolkata',
              apiKey: secret,
            },
          ],
        },
        logger,
        checkpointStore: new CheckpointStore(dirs.dataDir),
        coreErpClient: {
          sendHeartbeat: vi.fn().mockResolvedValue({
            success: true,
            serverTime: new Date().toISOString(),
            terminalId: 'x2008-main',
            terminalName: 'X2008 Main',
            status: 'ONLINE',
          }),
          submitPunches: vi.fn().mockImplementation(async (_k, _sn, punches) => {
            submittedPunches.push(...punches);
            return {
              success: true,
              totalReceived: punches.length,
              inserted: punches.length,
              duplicates: 0,
              unmappedEmployees: 0,
              terminalId: 'x2008-main',
              terminalName: 'X2008 Main',
            };
          }),
          syncUsers: vi.fn().mockImplementation(async (_k, _sn, payload) => {
            if (syncUsersShouldFail) {
              throw new CoreErpApiError(`503 Backend Busy (${secret})`, 503, 'HTTP_503');
            }
            syncedPayloads.push(payload);
            return {
              success: true,
              terminalId: 'x2008-main',
              terminalName: 'X2008 Main',
              discoveredCount: payload.deviceUsers.length,
              syncedCount: payload.deviceUsers.length,
              syncedAt: '2026-11-16T06:00:00.000Z',
            };
          }),
        },
        adapterFactory: () => ({
          protocolName: 'mock',
          connect: vi.fn().mockResolvedValue(undefined),
          getDeviceInfo: vi.fn().mockResolvedValue({
            serialNumber: 'NFZ8252800275',
            platform: 'ZLM60_TFT',
            fingerprintAlgorithm: 'VX10.0',
            firmwareVersion: '6.60',
            deviceName: 'eSSL X2008',
            oemVendor: 'eSSL',
          }),
          getAttendanceLogs: vi.fn().mockResolvedValue([
            {
              uid: 1,
              userEnrollmentId: '101',
              localDateTime: { year: 2026, month: 11, day: 16, hour: 9, minute: 0, second: 0 },
              verifyCode: 1,
              verifyType: 'FINGERPRINT',
              inOutCode: 0,
              inOutMode: 'CHECK_IN',
              workCode: 0,
              recordSequence: 0,
            },
          ]),
          getUsers: vi.fn().mockImplementation(async () => {
            if (getUsersShouldFail) {
              throw new Error('Device rejected USERTEMP_RRQ (reply command=2001)');
            }
            return realUsers;
          }),
          disconnect: vi.fn().mockResolvedValue(undefined),
        }),
      });

      // 1. Dedicated user sync succeeds without touching attendance punches
      const userRes = await runner.syncTerminalUsersOnce('x2008-main');
      expect(userRes.discoveredCount).toBe(1);
      expect(userRes.syncedCount).toBe(1);
      expect(syncedPayloads).toHaveLength(1);
      expect(syncedPayloads[0].deviceUsers[0]).toMatchObject({ enrollmentId: '101', name: 'Karthik Rao' });
      expect(submittedPunches).toHaveLength(0);

      // 2a. API upload failure during syncTerminalUsersOnce queues pendingUserSync and logs warning without secret
      syncUsersShouldFail = true;
      await expect(runner.syncTerminalUsersOnce('x2008-main')).rejects.toThrowError(/503 Backend Busy/);

      const afterUploadFail = runner.getStatusSnapshot().terminals[0];
      expect(afterUploadFail.lastUserSyncError).toMatch(/503 Backend Busy/);
      const cpAfterFail = new CheckpointStore(dirs.dataDir).getTerminal('x2008-main', 'NFZ8252800275');
      expect(cpAfterFail.pendingUserSync?.users).toHaveLength(1);

      // 2b. When CoreERP recovers, syncTerminalOnce() uploads punches AND clears pendingUserSync + error
      syncUsersShouldFail = false;
      const recoveryPollRes = await runner.syncTerminalOnce('x2008-main');
      expect(recoveryPollRes.uploadedCount).toBe(1);
      expect(submittedPunches).toHaveLength(1);
      expect(runner.getStatusSnapshot().terminals[0].lastUserSyncError).toBeNull();
      const cpRecovered = new CheckpointStore(dirs.dataDir).getTerminal('x2008-main', 'NFZ8252800275');
      expect(cpRecovered.pendingUserSync).toBeNull();
      expect(syncedPayloads).toHaveLength(2);

      // 3. When hardware getUsers() fails during punch polling, error is recorded & logged WITHOUT blocking punch polling
      getUsersShouldFail = true;
      const pollWithUserErr = await runner.syncTerminalOnce('x2008-main');
      expect(pollWithUserErr.pulledCount).toBe(1);
      expect(runner.getStatusSnapshot().terminals[0].lastUserSyncError).toMatch(/rejected USERTEMP_RRQ/);

      const logText = fs.readFileSync(path.join(dirs.logDir, 'user-sync-test.log'), 'utf8');
      expect(logText).toContain('terminal_user_upload_failed');
      expect(logText).toContain('terminal_user_query_failed');
      expect(logText).not.toContain(secret);
    });

    it('persists dedicated POST /api/biometric/users per terminal, isolates multiple terminals, and queues POST /api/biometric/devices/:id/sync-users without running PunchReconciliationService', async () => {
      createInMemoryCompanySettingStore();

      const keyA = 'bio_live_term_a_secret_0000111122223333';
      const keyB = 'bio_live_term_b_secret_0000111122223333';
      const hashA = crypto.createHash('sha256').update(keyA).digest('hex');
      const hashB = crypto.createHash('sha256').update(keyB).digest('hex');

      const termA = {
        id: 'term-a',
        companyId: 'comp-1',
        deviceSerialNumber: 'NFZ8252800275',
        name: 'Main X2008',
        terminalModel: 'eSSL X2008',
        ipAddress: '192.168.1.201',
        port: 4370,
        location: 'Lobby',
        apiKeyPrefix: 'bio_live_terma',
        apiKeyHash: hashA,
        status: 'ONLINE' as const,
        lastHeartbeatAt: new Date(),
        lastSyncAt: new Date(),
        firmwareVersion: 'Ver 6.60',
        registeredByUserId: 'u-admin',
        registeredByUser: { fullName: 'Admin' },
        isActive: true,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const termB = {
        ...termA,
        id: 'term-b',
        deviceSerialNumber: 'SN-GATE-B',
        name: 'Warehouse Terminal',
        apiKeyPrefix: 'bio_live_termb',
        apiKeyHash: hashB,
      };

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockImplementation((async (args: any) => {
        const where = args?.where || {};
        if (where.apiKeyHash === hashA) return termA as any;
        if (where.apiKeyHash === hashB) return termB as any;
        if (where.id === 'term-a' && where.companyId === 'comp-1') return termA as any;
        if (where.id === 'term-b' && where.companyId === 'comp-1') return termB as any;
        return null;
      }) as any);
      vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValue([termA, termB] as any);
      vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValue(termA as any);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([]);

      // Serial mismatch rejected on /api/biometric/users
      const mismatchRes = await request(app)
        .post('/api/biometric/users')
        .set('X-Device-Api-Key', keyA)
        .set('X-Device-Serial', 'WRONG-SERIAL')
        .send({ deviceUsers: [{ uid: 1, enrollmentId: '101', name: 'Karthik' }] });
      expect(mismatchRes.status).toBe(403);

      // Upload real user 101 to Terminal A
      const uploadARes = await request(app)
        .post('/api/biometric/users')
        .set('X-Device-Api-Key', keyA)
        .set('X-Device-Serial', 'NFZ8252800275')
        .send({
          discoveredCount: 1,
          deviceUsers: [{ uid: 1, enrollmentId: '101', name: 'Karthik Rao', cardNo: '445566' }],
        });
      expect(uploadARes.status).toBe(200);
      expect(uploadARes.body.discoveredCount).toBe(1);
      expect(uploadARes.body.syncedCount).toBe(1);

      // Upload different user 202 to Terminal B
      const uploadBRes = await request(app)
        .post('/api/biometric/users')
        .set('X-Device-Api-Key', keyB)
        .set('X-Device-Serial', 'SN-GATE-B')
        .send({
          discoveredCount: 1,
          deviceUsers: [{ uid: 5, enrollmentId: '202', name: 'Suresh B', cardNo: null }],
        });
      expect(uploadBRes.status).toBe(200);

      // Both terminals maintain isolated snapshots
      const options = await BiometricMappingService.getEnrollmentOptionsForCompany('comp-1');
      expect(options.deviceUsersByTerminal['term-a']).toHaveLength(1);
      expect(options.deviceUsersByTerminal['term-a'][0].enrollmentId).toBe('101');
      expect(options.deviceUsersByTerminal['term-b']).toHaveLength(1);
      expect(options.deviceUsersByTerminal['term-b'][0].enrollmentId).toBe('202');
      expect(options.terminals.find((t) => t.id === 'term-a')?.discoveredUserCount).toBe(1);
      expect(options.terminals.find((t) => t.id === 'term-a')?.syncedUserCount).toBe(1);

      // Admin triggers POST /api/biometric/devices/term-a/sync-users -> MUST NOT trigger PunchReconciliationService!
      const adminUser: AuthUser = {
        id: 'u-admin',
        userId: 'u-admin',
        companyId: 'comp-1',
        email: 'admin@namma.local',
        fullName: 'Admin User',
        role: 'ADMIN',
        isActive: true,
        tokenVersion: 1,
      };
      const adminToken = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({ ...adminUser } as any);
      vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null as any);
      const reconcileSpy = vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches');

      const triggerRes = await request(app)
        .post('/api/biometric/devices/term-a/sync-users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(triggerRes.status).toBe(200);
      expect(triggerRes.body.bridgeUserSyncQueued).toBe(true);
      expect(triggerRes.body.deviceUsers).toHaveLength(1);
      expect(reconcileSpy).not.toHaveBeenCalled();

      // Heartbeat sees userSyncRequested: true
      const hbRes = await request(app)
        .post('/api/biometric/heartbeat')
        .set('X-Device-Api-Key', keyA)
        .set('X-Device-Serial', 'NFZ8252800275')
        .send({ bridgeConnected: true });
      expect(hbRes.status).toBe(200);
      expect(hbRes.body.userSyncRequested).toBe(true);
      expect(hbRes.body.userSyncRequestedAt).toBeTruthy();

      // Empty user list on Terminal B clears its snapshot cleanly without affecting Terminal A
      const emptyBRes = await request(app)
        .post('/api/biometric/users')
        .set('X-Device-Api-Key', keyB)
        .set('X-Device-Serial', 'SN-GATE-B')
        .send({ discoveredCount: 0, deviceUsers: [] });
      expect(emptyBRes.status).toBe(200);
      expect(emptyBRes.body.syncedCount).toBe(0);

      const listARes = await request(app)
        .get('/api/biometric/devices/term-a/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(listARes.status).toBe(200);
      expect(listARes.body).toHaveLength(1);

      const listBRes = await request(app)
        .get('/api/biometric/devices/term-b/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(listBRes.status).toBe(200);
      expect(listBRes.body).toEqual([]);
    });
  });
});
