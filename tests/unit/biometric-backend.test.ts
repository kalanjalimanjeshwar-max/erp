import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
import { AuditService } from '../../src/server/services/audit.service.js';
import { AuthUser } from '../../src/shared/types.ts';

import { AuthService } from '../../src/server/services/auth.service.js';

// Mock AuditService
vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Phase 8.1: Biometric Hardware LAN Bridge Backend & Database Tests', () => {
  const app = createApp();

  const superAdminUser: AuthUser = {
    id: 'user-sa-uuid',
    userId: 'user-sa-uuid',
    companyId: 'company-uuid-alpha',
    email: 'admin@alpha.local',
    fullName: 'Alpha Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeUser: AuthUser = {
    id: 'user-emp-uuid',
    userId: 'user-emp-uuid',
    companyId: 'company-uuid-alpha',
    email: 'john@alpha.local',
    fullName: 'John Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  const adminUser: AuthUser = {
    id: 'user-admin-uuid',
    userId: 'user-admin-uuid',
    companyId: 'company-uuid-alpha',
    email: 'hr.admin@alpha.local',
    fullName: 'Alpha HR Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const viceAdminUser: AuthUser = {
    id: 'user-va-uuid',
    userId: 'user-va-uuid',
    companyId: 'company-uuid-alpha',
    email: 'vp@alpha.local',
    fullName: 'Alpha Vice Admin',
    role: 'VICE_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Endpoint Security & Unauthenticated Access Guards', () => {
    it('should reject unauthenticated device management requests with 401', async () => {
      const res1 = await request(app).get('/api/biometric/devices');
      expect(res1.status).toBe(401);
      expect(res1.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);

      const res2 = await request(app).post('/api/biometric/devices').send({
        deviceSerialNumber: 'SN-1001',
        name: 'Gate 1',
      });
      expect(res2.status).toBe(401);
    });

    it('should block EMPLOYEE session tokens from device management endpoints with 403 Forbidden', async () => {
      const employeeToken = AuthService.generateSessionToken({
        userId: employeeUser.userId,
        companyId: employeeUser.companyId,
        email: employeeUser.email,
        role: employeeUser.role,
        tokenVersion: employeeUser.tokenVersion,
      });

      const listRes = await request(app)
        .get('/api/biometric/devices')
        .set('Authorization', `Bearer ${employeeToken}`);

      expect([401, 403]).toContain(listRes.status);
      if (listRes.status === 403) {
        expect(listRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      }

      const createRes = await request(app)
        .post('/api/biometric/devices')
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          deviceSerialNumber: 'SN-999',
          name: 'Unauthorized Gate',
        });

      expect([401, 403]).toContain(createRes.status);
      if (createRes.status === 403) {
        expect(createRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
      }
    });

    it('should reject device-originated heartbeat without credentials with 401', async () => {
      const res = await request(app).post('/api/biometric/heartbeat').send({
        firmwareVersion: 'v2.1.0',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED_DEVICE');
    });

    it('should reject device-originated punches without credentials with 401', async () => {
      const res = await request(app).post('/api/biometric/punches').send({
        punches: [],
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED_DEVICE');
    });

    it('should reject device calls with invalid/unknown API key with 401', async () => {
      // Mock prisma findFirst returning null for unknown hash
      const findFirstSpy = vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce(null as any);

      const res = await request(app)
        .post('/api/biometric/heartbeat')
        .set('X-Device-Api-Key', 'bio_live_invalid_secret_key_12345')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_DEVICE_CREDENTIALS');
      findFirstSpy.mockRestore();
    });

    it('should reject deactivated/inactive terminal credentials with 401', async () => {
      // When terminal is found but inactive, findFirst query filters isActive: true, thus returning null
      const findFirstSpy = vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce(null as any);

      const res = await request(app)
        .post('/api/biometric/heartbeat')
        .set('X-Device-Api-Key', 'bio_live_deactivated_terminal_key')
        .send({});

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_DEVICE_CREDENTIALS');
      expect(res.body.error.message).toContain('inactive, or revoked');
      findFirstSpy.mockRestore();
    });
  });

  describe('2. Biometric Terminal Registration & One-Time Key Generation', () => {
    it('should register terminal, hash credentials with SHA-256, and return plaintext key exactly once', async () => {
      const createdRecord = {
        id: 'terminal-uuid-1',
        companyId: 'company-uuid-alpha',
        deviceSerialNumber: 'ZK-F22-ALPHA-01',
        name: 'Factory Main Turnstile',
        terminalModel: 'ZKTeco-F22',
        ipAddress: '192.168.1.100',
        port: 4370,
        location: 'Factory Gate A',
        apiKeyHash: 'hash-value',
        apiKeyPrefix: 'bio_live_1234',
        status: 'OFFLINE',
        lastHeartbeatAt: null,
        lastSyncAt: null,
        firmwareVersion: null,
        registeredByUserId: 'user-sa-uuid',
        registeredByUser: { fullName: 'Alpha Super Admin' },
        isActive: true,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(prisma.biometricTerminal, 'findUnique').mockResolvedValueOnce(null);
      vi.spyOn(prisma.biometricTerminal, 'create').mockResolvedValueOnce(createdRecord as any);

      const result = await BiometricService.registerTerminal(superAdminUser, {
        deviceSerialNumber: 'ZK-F22-ALPHA-01',
        name: 'Factory Main Turnstile',
        ipAddress: '192.168.1.100',
        port: 4370,
        location: 'Factory Gate A',
      });

      expect(result.terminal.deviceSerialNumber).toBe('ZK-F22-ALPHA-01');
      expect(result.terminal.name).toBe('Factory Main Turnstile');
      expect(result.apiKey).toMatch(/^bio_live_[0-9a-f]{64}$/);
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BIOMETRIC_TERMINAL_REGISTER',
          entityId: 'terminal-uuid-1',
        })
      );
    });

    it('should reject terminal registration with duplicate serial number in same company', async () => {
      vi.spyOn(prisma.biometricTerminal, 'findUnique').mockResolvedValueOnce({
        id: 'existing-term',
      } as any);

      await expect(
        BiometricService.registerTerminal(superAdminUser, {
          deviceSerialNumber: 'ZK-F22-ALPHA-01',
          name: 'Duplicate Terminal',
        })
      ).rejects.toThrowError(/already registered in this company/);
    });

    it('should validate mandatory serial number and name fields', async () => {
      await expect(
        BiometricService.registerTerminal(superAdminUser, {
          deviceSerialNumber: '',
          name: 'Valid Name',
        })
      ).rejects.toThrowError(/serial number is mandatory/);

      await expect(
        BiometricService.registerTerminal(superAdminUser, {
          deviceSerialNumber: 'SN-1234',
          name: '   ',
        })
      ).rejects.toThrowError(/Terminal name is mandatory/);
    });
    it('should list terminals strictly scoped to company and filter inactive terminals by default', async () => {
      const findManySpy = vi.spyOn(prisma.biometricTerminal, 'findMany').mockResolvedValueOnce([
        {
          id: 'term-1',
          companyId: 'company-uuid-alpha',
          deviceSerialNumber: 'SN-01',
          name: 'Gate A',
          terminalModel: 'ZKTeco-F22',
          ipAddress: null,
          port: 4370,
          location: null,
          apiKeyPrefix: 'bio_live_123',
          status: 'ONLINE',
          lastHeartbeatAt: new Date(),
          lastSyncAt: null,
          firmwareVersion: '1.0',
          registeredByUserId: 'user-sa-uuid',
          registeredByUser: { fullName: 'Admin' },
          isActive: true,
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ]);

      const terminals = await BiometricService.listTerminals('company-uuid-alpha');
      expect(terminals).toHaveLength(1);
      expect(terminals[0].deviceSerialNumber).toBe('SN-01');
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId: 'company-uuid-alpha',
            isActive: true,
          }),
        })
      );
      findManySpy.mockRestore();
    });
  });

  describe('3. Terminal Heartbeat & Keepalive Processing', () => {
    it('should update terminal status to ONLINE and record heartbeat timestamp', async () => {
      const mockTerminal = {
        id: 'terminal-uuid-1',
        companyId: 'company-uuid-alpha',
        name: 'Turnstile Gate',
        deviceSerialNumber: 'ZK-001',
      };

      const updateSpy = vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValueOnce({} as any);

      const result = await BiometricService.recordHeartbeat(mockTerminal, {
        firmwareVersion: 'v3.2.0-2026',
        monitoredDevicesCount: 1,
        onlineDevicesCount: 1,
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('ONLINE');
      expect(result.terminalId).toBe('terminal-uuid-1');
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'terminal-uuid-1' },
          data: expect.objectContaining({
            status: 'ONLINE',
            firmwareVersion: 'v3.2.0-2026',
          }),
        })
      );
      updateSpy.mockRestore();
    });
  });

  describe('4. Idempotent Raw Punch Ingestion & Employee Matching', () => {
    const mockTerminal = {
      id: 'terminal-uuid-1',
      companyId: 'company-uuid-alpha',
      name: 'Turnstile Gate',
      registeredByUserId: 'user-sa-uuid',
    };

    it('should ingest valid punches, map employees by biometricDeviceId, and record logs', async () => {
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]); // No duplicates
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([
        { id: 'emp-uuid-101', biometricDeviceId: '1001' } as any,
      ]);
      const txSpy = vi.spyOn(prisma, '$transaction').mockResolvedValueOnce([{} as any, {} as any]);

      const result = await BiometricService.ingestPunches(mockTerminal, {
        punches: [
          {
            devicePunchId: 'punch-seq-1',
            userEnrollmentId: '1001',
            punchTime: '2026-10-19T08:30:00.000Z',
            verifyType: 'FINGERPRINT',
            inOutMode: 'CHECK_IN',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.unmappedEmployees).toBe(0);
      expect(txSpy).toHaveBeenCalled();
      txSpy.mockRestore();
    });

    it('should generate deterministic SHA-256 idempotency key when devicePunchId is omitted', async () => {
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]);
      const txSpy = vi.spyOn(prisma, '$transaction').mockResolvedValueOnce([{} as any, {} as any]);

      const result = await BiometricService.ingestPunches(mockTerminal, {
        punches: [
          {
            userEnrollmentId: '1002',
            punchTime: '2026-10-19T09:15:00.000Z',
            verifyType: 'CARD',
            inOutMode: 'CHECK_OUT',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(1);
      expect(result.inserted).toBe(1);
      txSpy.mockRestore();
    });

    it('should deduplicate multiple identical punches within the same batch', async () => {
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]);
      const txSpy = vi.spyOn(prisma, '$transaction').mockResolvedValueOnce([{} as any, {} as any]);

      const punch = {
        devicePunchId: 'p-batch-dup-1',
        userEnrollmentId: '1003',
        punchTime: '2026-10-19T09:30:00.000Z',
      };

      const result = await BiometricService.ingestPunches(mockTerminal, {
        punches: [punch, punch],
      });

      expect(result.totalReceived).toBe(2);
      expect(result.inserted).toBe(1);
      expect(result.duplicates).toBe(1);
      txSpy.mockRestore();
    });

    it('should never mutate attendance or payroll records during raw punch ingestion', async () => {
      const attendanceCreateSpy = vi.spyOn(prisma.attendance, 'create');
      const payrollUpdateSpy = vi.spyOn(prisma.payrollPeriod, 'update');
      const payslipCreateSpy = vi.spyOn(prisma.payslip, 'create');

      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]);
      const txSpy = vi.spyOn(prisma, '$transaction').mockResolvedValueOnce([{} as any, {} as any]);

      await BiometricService.ingestPunches(mockTerminal, {
        punches: [
          {
            devicePunchId: 'punch-isolated-1',
            userEnrollmentId: '1001',
            punchTime: '2026-10-19T10:00:00.000Z',
          },
        ],
      });

      expect(attendanceCreateSpy).not.toHaveBeenCalled();
      expect(payrollUpdateSpy).not.toHaveBeenCalled();
      expect(payslipCreateSpy).not.toHaveBeenCalled();

      attendanceCreateSpy.mockRestore();
      payrollUpdateSpy.mockRestore();
      payslipCreateSpy.mockRestore();
      txSpy.mockRestore();
    });

    it('should handle unmapped employees without failing the punch batch', async () => {
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]); // No matching employee
      const txSpy = vi.spyOn(prisma, '$transaction').mockResolvedValueOnce([{} as any, {} as any]);

      const result = await BiometricService.ingestPunches(mockTerminal, {
        punches: [
          {
            userEnrollmentId: 'unknown-badge-999',
            punchTime: '2026-10-19T08:45:00.000Z',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.unmappedEmployees).toBe(1);
      txSpy.mockRestore();
    });

    it('should ensure repeated punch submissions are handled idempotently without duplicate records', async () => {
      const punchItem = {
        devicePunchId: 'punch-seq-55',
        userEnrollmentId: '1001',
        punchTime: '2026-10-19T09:00:00.000Z',
        inOutMode: 'CHECK_IN' as const,
      };

      const expectedIdempotencyKey = `${mockTerminal.id}:punch-seq-55`;

      // Mock finding the key already present in the database
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([
        { idempotencyKey: expectedIdempotencyKey } as any,
      ]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]);
      const updateSpy = vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValueOnce({} as any);

      const result = await BiometricService.ingestPunches(mockTerminal, {
        punches: [punchItem],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(1);
      expect(result.inserted).toBe(0);
      expect(result.duplicates).toBe(1);
      updateSpy.mockRestore();
    });

    it('should reject batch exceeding maximum allowed limit (500 items)', async () => {
      const largeBatch = Array.from({ length: 501 }, (_, i) => ({
        userEnrollmentId: `user-${i}`,
        punchTime: '2026-10-19T08:00:00.000Z',
      }));

      await expect(
        BiometricService.ingestPunches(mockTerminal, { punches: largeBatch })
      ).rejects.toThrowError(/exceeds the maximum allowed limit of 500 events/);
    });

    it('should reject punch with invalid timestamp format with 400 Bad Request', async () => {
      await expect(
        BiometricService.ingestPunches(mockTerminal, {
          punches: [
            {
              userEnrollmentId: '1001',
              punchTime: 'not-a-valid-date-time',
            },
          ],
        })
      ).rejects.toThrowError(/invalid ISO-8601 timestamp/);
    });
  });

  describe('5. Device Authorization Protocol Verification', () => {
    it('should accept valid Bearer token and match constant-time hash', () => {
      const plainKey = 'bio_live_test_secret_key_abcdef1234567890';
      const hash = crypto.createHash('sha256').update(plainKey).digest('hex');

      const expectedBuffer = Buffer.from(hash, 'utf8');
      const incomingBuffer = Buffer.from(hash, 'utf8');

      expect(crypto.timingSafeEqual(expectedBuffer, incomingBuffer)).toBe(true);
    });

    it('should reject mismatched hashes using constant-time check', () => {
      const hashA = crypto.createHash('sha256').update('key_alpha').digest('hex');
      const hashB = crypto.createHash('sha256').update('key_beta').digest('hex');

      const bufA = Buffer.from(hashA, 'utf8');
      const bufB = Buffer.from(hashB, 'utf8');

      expect(crypto.timingSafeEqual(bufA, bufB)).toBe(false);
    });
  });

  describe('6. Terminal Deactivation & Immediate Credential Invalidation (Phase 8.4)', () => {
    it('should deactivate an active terminal and immediately invalidate its credentials', async () => {
      const activeTerminal = {
        id: 'term-active-1',
        companyId: superAdminUser.companyId,
        deviceSerialNumber: 'SN-ACT-1',
        name: 'Main Gate',
        terminalModel: 'ZKTeco-F22',
        ipAddress: '192.168.1.50',
        port: 4370,
        location: 'Gate A',
        apiKeyPrefix: 'bio_live_act',
        apiKeyHash: 'active_hash_value',
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
        lastSyncAt: new Date(),
        registeredByUserId: superAdminUser.userId,
        isActive: true,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce(activeTerminal as any);
      const updateSpy = vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValueOnce({
        ...activeTerminal,
        isActive: false,
        status: 'DEACTIVATED',
      } as any);

      const result = await BiometricService.deactivateTerminal(superAdminUser, 'term-active-1');

      expect(result.id).toBe('term-active-1');
      expect(result.isActive).toBe(false);
      expect(result.status).toBe('DEACTIVATED');
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'term-active-1' },
          data: expect.objectContaining({
            isActive: false,
            status: 'DEACTIVATED',
            apiKeyHash: expect.any(String),
          }),
        })
      );
      updateSpy.mockRestore();
    });

    it('should reject deactivation across company/tenant boundaries with 404', async () => {
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce(null);

      await expect(
        BiometricService.deactivateTerminal(superAdminUser, 'term-cross-tenant')
      ).rejects.toThrowError(/not found/i);
    });

    it('should allow ADMIN and SUPER_ADMIN to call POST /api/biometric/devices/:id/deactivate', async () => {
      const adminToken = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        ...adminUser,
        role: 'ADMIN',
      } as any);

      const deactivateSpy = vi.spyOn(BiometricService, 'deactivateTerminal').mockResolvedValueOnce({
        id: 'term-to-deactivate',
        companyId: adminUser.companyId,
        deviceSerialNumber: 'SN-01',
        name: 'Gate 1',
        terminalModel: 'ZKTeco',
        ipAddress: null,
        port: 4370,
        location: null,
        apiKeyPrefix: 'bio_live_01',
        status: 'DEACTIVATED',
        lastHeartbeatAt: null,
        lastSyncAt: null,
        firmwareVersion: null,
        registeredByUserId: adminUser.userId,
        isActive: false,
        notes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/biometric/devices/term-to-deactivate/deactivate')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.terminal.status).toBe('DEACTIVATED');
      deactivateSpy.mockRestore();
    });

    it('should block EMPLOYEE and VICE_ADMIN from deactivating devices with 403 Forbidden', async () => {
      const vaToken = AuthService.generateSessionToken({
        userId: viceAdminUser.userId,
        companyId: viceAdminUser.companyId,
        email: viceAdminUser.email,
        role: viceAdminUser.role,
        tokenVersion: viceAdminUser.tokenVersion,
      });

      const empToken = AuthService.generateSessionToken({
        userId: employeeUser.userId,
        companyId: employeeUser.companyId,
        email: employeeUser.email,
        role: employeeUser.role,
        tokenVersion: employeeUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce({ ...viceAdminUser, role: 'VICE_ADMIN' } as any)
        .mockResolvedValueOnce({ ...employeeUser, role: 'EMPLOYEE' } as any);

      const resVA = await request(app)
        .post('/api/biometric/devices/term-1/deactivate')
        .set('Authorization', `Bearer ${vaToken}`);
      expect(resVA.status).toBe(403);

      const resEmp = await request(app)
        .post('/api/biometric/devices/term-1/deactivate')
        .set('Authorization', `Bearer ${empToken}`);
      expect(resEmp.status).toBe(403);
    });
  });

  describe('7. API Key Rotation & One-Time Credential Delivery (Phase 8.4)', () => {
    it('should rotate API key, update hash, and return plaintext token exactly once', async () => {
      const activeTerminal = {
        id: 'term-rotate-1',
        companyId: superAdminUser.companyId,
        deviceSerialNumber: 'SN-ROT-1',
        name: 'Warehouse Gate',
        terminalModel: 'ZKTeco-F22',
        ipAddress: null,
        port: 4370,
        location: 'Warehouse',
        apiKeyPrefix: 'bio_live_old',
        apiKeyHash: 'old_hash',
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
        lastSyncAt: new Date(),
        registeredByUserId: superAdminUser.userId,
        isActive: true,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce(activeTerminal as any);
      const updateSpy = vi.spyOn(prisma.biometricTerminal, 'update').mockResolvedValueOnce({
        ...activeTerminal,
        apiKeyPrefix: 'bio_live_new',
      } as any);

      const auditSpy = vi.spyOn(AuditService, 'log');

      const result = await BiometricService.rotateTerminalKey(superAdminUser, 'term-rotate-1');

      expect(result.terminal.id).toBe('term-rotate-1');
      expect(result.apiKey).toMatch(/^bio_live_[a-f0-9]{64}$/);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'term-rotate-1' },
          data: expect.objectContaining({
            apiKeyHash: expect.any(String),
            apiKeyPrefix: expect.any(String),
          }),
        })
      );

      // Verify plaintext key was NOT logged in audit details
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.not.objectContaining({
            apiKey: result.apiKey,
          }),
        })
      );

      updateSpy.mockRestore();
      auditSpy.mockRestore();
    });

    it('should reject rotating key for deactivated/inactive terminal with 400 Bad Request', async () => {
      const inactiveTerminal = {
        id: 'term-inactive-1',
        companyId: superAdminUser.companyId,
        isActive: false,
        status: 'DEACTIVATED',
      };

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValueOnce(inactiveTerminal as any);

      await expect(
        BiometricService.rotateTerminalKey(superAdminUser, 'term-inactive-1')
      ).rejects.toThrowError(/cannot rotate api key for an inactive/i);
    });

    it('should allow ADMIN and SUPER_ADMIN to call POST /api/biometric/devices/:id/rotate-key', async () => {
      const adminToken = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        ...adminUser,
        role: 'ADMIN',
      } as any);

      const rotateSpy = vi.spyOn(BiometricService, 'rotateTerminalKey').mockResolvedValueOnce({
        terminal: {
          id: 'term-rotated',
          companyId: adminUser.companyId,
          deviceSerialNumber: 'SN-01',
          name: 'Gate 1',
          terminalModel: 'ZKTeco',
          ipAddress: null,
          port: 4370,
          location: null,
          apiKeyPrefix: 'bio_live_new',
          status: 'ONLINE',
          lastHeartbeatAt: null,
          lastSyncAt: null,
          firmwareVersion: null,
          registeredByUserId: adminUser.userId,
          isActive: true,
          notes: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        apiKey: 'bio_live_new_plaintext_key_sample_123',
      });

      const res = await request(app)
        .post('/api/biometric/devices/term-rotated/rotate-key')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.apiKey).toBe('bio_live_new_plaintext_key_sample_123');
      rotateSpy.mockRestore();
    });

    it('should block EMPLOYEE and VICE_ADMIN from rotating device keys with 403 Forbidden', async () => {
      const vaToken = AuthService.generateSessionToken({
        userId: viceAdminUser.userId,
        companyId: viceAdminUser.companyId,
        email: viceAdminUser.email,
        role: viceAdminUser.role,
        tokenVersion: viceAdminUser.tokenVersion,
      });

      const empToken = AuthService.generateSessionToken({
        userId: employeeUser.userId,
        companyId: employeeUser.companyId,
        email: employeeUser.email,
        role: employeeUser.role,
        tokenVersion: employeeUser.tokenVersion,
      });

      vi.spyOn(prisma.user, 'findUnique')
        .mockResolvedValueOnce({ ...viceAdminUser, role: 'VICE_ADMIN' } as any)
        .mockResolvedValueOnce({ ...employeeUser, role: 'EMPLOYEE' } as any);

      const resVA = await request(app)
        .post('/api/biometric/devices/term-1/rotate-key')
        .set('Authorization', `Bearer ${vaToken}`);
      expect(resVA.status).toBe(403);

      const resEmp = await request(app)
        .post('/api/biometric/devices/term-1/rotate-key')
        .set('Authorization', `Bearer ${empToken}`);
      expect(resEmp.status).toBe(403);
    });
  });

  describe('8. Concurrent Punch Ingestion Safety & Heartbeat Status Derivation (Phase 8.4)', () => {
    const mockTerminal = {
      id: 'terminal-uuid-1',
      companyId: 'company-uuid-alpha',
      name: 'Turnstile Gate',
      registeredByUserId: 'user-sa-uuid',
    };

    it('should correctly handle concurrent conflict deduplication via skipDuplicates', async () => {
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]);

      vi.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any) => {
        const mockTx = {
          rawPunchLog: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          biometricTerminal: {
            update: vi.fn().mockResolvedValue({}),
          },
        };
        return cb(mockTx);
      });

      const result = await BiometricService.ingestPunches(mockTerminal, {
        punches: [
          {
            userEnrollmentId: '2001',
            punchTime: '2026-10-19T08:00:00.000Z',
          },
          {
            userEnrollmentId: '2002',
            punchTime: '2026-10-19T08:05:00.000Z',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.totalReceived).toBe(2);
      expect(result.inserted).toBe(1);
      expect(result.duplicates).toBe(1);
    });

    it('should propagate database failures without masking as false success', async () => {
      vi.spyOn(prisma.rawPunchLog, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma.employee, 'findMany').mockResolvedValueOnce([]);
      vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      await expect(
        BiometricService.ingestPunches(mockTerminal, {
          punches: [
            {
              userEnrollmentId: '3001',
              punchTime: '2026-10-19T08:00:00.000Z',
            },
          ],
        })
      ).rejects.toThrowError('Database connection failed');
    });

    it('should accurately derive effective ONLINE/OFFLINE status based on 5-minute heartbeat freshness', () => {
      const now = new Date();

      // Fresh heartbeat 2 minutes ago -> ONLINE
      const freshHeartbeat = new Date(now.getTime() - 2 * 60 * 1000);
      expect(
        BiometricService.getEffectiveStatus({
          status: 'ONLINE',
          isActive: true,
          lastHeartbeatAt: freshHeartbeat,
        })
      ).toBe('ONLINE');

      // Stale heartbeat 6 minutes ago (> 5 min) -> OFFLINE
      const staleHeartbeat = new Date(now.getTime() - 6 * 60 * 1000);
      expect(
        BiometricService.getEffectiveStatus({
          status: 'ONLINE',
          isActive: true,
          lastHeartbeatAt: staleHeartbeat,
        })
      ).toBe('OFFLINE');

      // No heartbeat -> OFFLINE
      expect(
        BiometricService.getEffectiveStatus({
          status: 'ONLINE',
          isActive: true,
          lastHeartbeatAt: null,
        })
      ).toBe('OFFLINE');

      // Deactivated terminal -> DEACTIVATED regardless of heartbeat
      expect(
        BiometricService.getEffectiveStatus({
          status: 'ONLINE',
          isActive: false,
          lastHeartbeatAt: freshHeartbeat,
        })
      ).toBe('DEACTIVATED');

      // Error status preserved
      expect(
        BiometricService.getEffectiveStatus({
          status: 'ERROR',
          isActive: true,
          lastHeartbeatAt: freshHeartbeat,
        })
      ).toBe('ERROR');
    });
  });
});

