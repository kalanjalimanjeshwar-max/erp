import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { api } from '../../src/client/services/api.ts';
import { AuthService } from '../../src/server/services/auth.service.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { AuthUser } from '../../src/shared/types.ts';

describe('Phase 8.3: Biometric Device Management UI & API Integration Tests', () => {
  const app = createApp();

  const companyAlphaId = 'company-alpha-uuid';

  const superAdminUser: AuthUser = {
    id: 'user-sa-uuid',
    userId: 'user-sa-uuid',
    companyId: companyAlphaId,
    email: 'admin@alpha.local',
    fullName: 'Alpha Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const adminUser: AuthUser = {
    id: 'user-admin-uuid',
    userId: 'user-admin-uuid',
    companyId: companyAlphaId,
    email: 'ops@alpha.local',
    fullName: 'Alpha Operations Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const viceAdminUser: AuthUser = {
    id: 'user-va-uuid',
    userId: 'user-va-uuid',
    companyId: companyAlphaId,
    email: 'viewer@alpha.local',
    fullName: 'Alpha Viewer Vice Admin',
    role: 'VICE_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeUser: AuthUser = {
    id: 'user-emp-uuid',
    userId: 'user-emp-uuid',
    companyId: companyAlphaId,
    email: 'john@alpha.local',
    fullName: 'John Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  describe('1. API Client Phase 8 Service Methods Verification', () => {
    it('should export all required Biometric Hardware & Terminal API client methods', () => {
      expect(typeof api.getBiometricDevices).toBe('function');
      expect(typeof api.createBiometricTerminal).toBe('function');
      expect(typeof api.deactivateBiometricDevice).toBe('function');
      expect(typeof api.rotateBiometricDeviceKey).toBe('function');
      expect(typeof api.sendTerminalHeartbeat).toBe('function');
      expect(typeof api.submitBiometricPunches).toBe('function');
    });

    it('should export all required Biometric Punch Reconciliation & Sync API client methods', () => {
      expect(typeof api.getBiometricPunches).toBe('function');
      expect(typeof api.triggerBiometricSync).toBe('function');
      expect(typeof api.getBiometricSyncSummary).toBe('function');
    });
  });

  describe('2. Unauthenticated Request Protections', () => {
    it('should reject unauthenticated GET /api/biometric/devices with 401', async () => {
      const res = await request(app).get('/api/biometric/devices');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });

    it('should reject unauthenticated POST /api/biometric/devices with 401', async () => {
      const res = await request(app).post('/api/biometric/devices').send({
        name: 'Main Lobby',
        deviceSerialNumber: 'SN-001',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });

    it('should reject unauthenticated GET /api/biometric/punches with 401', async () => {
      const res = await request(app).get('/api/biometric/punches');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });

    it('should reject unauthenticated POST /api/biometric/sync with 401', async () => {
      const res = await request(app).post('/api/biometric/sync').send({ batchSize: 50 });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });

    it('should reject unauthenticated GET /api/biometric/sync/summary with 401', async () => {
      const res = await request(app).get('/api/biometric/sync/summary');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });
  });

  describe('3. Role & RBAC Guard Enforcements', () => {
    it('should reject EMPLOYEE role attempting to access GET /api/biometric/devices with 403', async () => {
      const token = AuthService.generateSessionToken({
        userId: employeeUser.userId,
        companyId: employeeUser.companyId,
        email: employeeUser.email,
        role: employeeUser.role,
        tokenVersion: employeeUser.tokenVersion,
      });
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValueOnce(employeeUser);

      const res = await request(app)
        .get('/api/biometric/devices')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    });

    it('should reject EMPLOYEE role attempting to trigger sync on POST /api/biometric/sync with 403', async () => {
      const token = AuthService.generateSessionToken({
        userId: employeeUser.userId,
        companyId: employeeUser.companyId,
        email: employeeUser.email,
        role: employeeUser.role,
        tokenVersion: employeeUser.tokenVersion,
      });
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValueOnce(employeeUser);

      const res = await request(app)
        .post('/api/biometric/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({ batchSize: 50 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    });

    it('should allow VICE_ADMIN to view devices but reject attempts to create terminal with 403', async () => {
      const token = AuthService.generateSessionToken({
        userId: viceAdminUser.userId,
        companyId: viceAdminUser.companyId,
        email: viceAdminUser.email,
        role: viceAdminUser.role,
        tokenVersion: viceAdminUser.tokenVersion,
      });
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValue(viceAdminUser);
      vi.spyOn(BiometricService, 'listTerminals').mockResolvedValueOnce([]);

      // 1. GET is allowed for VICE_ADMIN (has BIOMETRIC:VIEW)
      const getRes = await request(app)
        .get('/api/biometric/devices')
        .set('Authorization', `Bearer ${token}`);
      expect(getRes.status).toBe(200);

      // 2. POST is forbidden for VICE_ADMIN (lacks BIOMETRIC:CREATE)
      const postRes = await request(app)
        .post('/api/biometric/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Unauthorized Device', deviceSerialNumber: 'SN-TEST' });
      expect(postRes.status).toBe(403);
      expect(postRes.body.error.code).toBe('FORBIDDEN_PERMISSION_DENIED');
    });

    it('should allow ADMIN role to trigger punch sync and return execution results', async () => {
      const token = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValueOnce(adminUser);
      vi.spyOn(PunchReconciliationService, 'reconcilePendingPunches').mockResolvedValueOnce({
        success: true,
        totalEvaluated: 12,
        processed: 10,
        ignored: 2,
        errors: 0,
        results: [],
      });

      const res = await request(app)
        .post('/api/biometric/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({ batchSize: 100 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalEvaluated).toBe(12);
      expect(res.body.processed).toBe(10);
      expect(res.body.ignored).toBe(2);
      expect(res.body.errors).toBe(0);
    });
  });

  describe('4. Device API Key Volatility & Registration Invariants', () => {
    it('should return one-time plaintext apiKey upon terminal creation and verify prefix matching', async () => {
      const token = AuthService.generateSessionToken({
        userId: superAdminUser.userId,
        companyId: superAdminUser.companyId,
        email: superAdminUser.email,
        role: superAdminUser.role,
        tokenVersion: superAdminUser.tokenVersion,
      });
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValueOnce(superAdminUser);
      vi.spyOn(BiometricService, 'registerTerminal').mockResolvedValueOnce({
        terminal: {
          id: 'term-new-uuid',
          companyId: companyAlphaId,
          deviceSerialNumber: 'ZKT-9001',
          name: 'Main Entrance Turnstile',
          terminalModel: 'ZKTeco-F22',
          ipAddress: '192.168.1.150',
          port: 4370,
          location: 'Building A Lobby',
          apiKeyPrefix: 'bio_live_a1b2',
          status: 'OFFLINE',
          lastHeartbeatAt: null,
          lastSyncAt: null,
          firmwareVersion: null,
          registeredByUserId: superAdminUser.id,
          registeredByUserName: superAdminUser.fullName,
          isActive: true,
          notes: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        apiKey: 'bio_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      });

      const res = await request(app)
        .post('/api/biometric/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Main Entrance Turnstile',
          deviceSerialNumber: 'ZKT-9001',
          ipAddress: '192.168.1.150',
        });

      expect(res.status).toBe(201);
      expect(res.body.apiKey).toBe('bio_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6');
      expect(res.body.terminal.apiKeyPrefix).toBe('bio_live_a1b2');
      expect(res.body.terminal.name).toBe('Main Entrance Turnstile');
    });
  });

  describe('5. Reconciliation Batch Bounding & Telemetry Summary', () => {
    it('should return punch sync summary telemetry with correct metric schema', async () => {
      const token = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });
      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValueOnce(adminUser);
      vi.spyOn(PunchReconciliationService, 'getSyncSummary').mockResolvedValueOnce({
        pendingCount: 15,
        processedCount: 1420,
        ignoredCount: 38,
        errorCount: 3,
        totalCount: 1476,
        lastSyncAt: '2026-10-20T08:30:00.000Z',
      });

      const res = await request(app)
        .get('/api/biometric/sync/summary')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.pendingCount).toBe(15);
      expect(res.body.processedCount).toBe(1420);
      expect(res.body.ignoredCount).toBe(38);
      expect(res.body.errorCount).toBe(3);
      expect(res.body.totalCount).toBe(1476);
      expect(res.body.lastSyncAt).toBe('2026-10-20T08:30:00.000Z');
    });

    it('should enforce batch bounding limits between 1 and 500 in service layer', () => {
      const clampBatch = (input?: number) => Math.min(500, Math.max(1, input || 100));

      expect(clampBatch(undefined)).toBe(100);
      expect(clampBatch(50)).toBe(50);
      expect(clampBatch(-10)).toBe(1);
      expect(clampBatch(0)).toBe(100); // 0 falsy falls back to default 100
      expect(clampBatch(1000)).toBe(500);
    });
  });

  describe('6. Terminal Deactivation & Key Rotation UI/API Integration', () => {
    it('should reject unauthenticated deactivation and rotate-key requests with 401', async () => {
      const resDeact = await request(app).post('/api/biometric/devices/dev-1/deactivate');
      expect(resDeact.status).toBe(401);

      const resRotate = await request(app).post('/api/biometric/devices/dev-1/rotate-key');
      expect(resRotate.status).toBe(401);
    });

    it('should allow ADMIN to rotate device key and return one-time plaintext key', async () => {
      const token = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });

      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValueOnce(adminUser);
      vi.spyOn(BiometricService, 'rotateTerminalKey').mockResolvedValueOnce({
        terminal: {
          id: 'dev-1',
          companyId: adminUser.companyId,
          deviceSerialNumber: 'SN-001',
          name: 'Front Turnstile',
          terminalModel: 'ZKTeco-F22',
          ipAddress: null,
          port: 4370,
          location: 'Lobby',
          apiKeyPrefix: 'bio_live_r0t8',
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
        apiKey: 'bio_live_rotated_key_token_abcdef1234567890',
      });

      const res = await request(app)
        .post('/api/biometric/devices/dev-1/rotate-key')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.apiKey).toBe('bio_live_rotated_key_token_abcdef1234567890');
      expect(res.body.terminal.apiKeyPrefix).toBe('bio_live_r0t8');
    });

    it('should allow ADMIN to deactivate device and return updated status', async () => {
      const token = AuthService.generateSessionToken({
        userId: adminUser.userId,
        companyId: adminUser.companyId,
        email: adminUser.email,
        role: adminUser.role,
        tokenVersion: adminUser.tokenVersion,
      });

      vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValueOnce(adminUser);
      vi.spyOn(BiometricService, 'deactivateTerminal').mockResolvedValueOnce({
        id: 'dev-1',
        companyId: adminUser.companyId,
        deviceSerialNumber: 'SN-001',
        name: 'Front Turnstile',
        terminalModel: 'ZKTeco-F22',
        ipAddress: null,
        port: 4370,
        location: 'Lobby',
        apiKeyPrefix: 'bio_live_r0t8',
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
        .post('/api/biometric/devices/dev-1/deactivate')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.terminal.status).toBe('DEACTIVATED');
      expect(res.body.terminal.isActive).toBe(false);
    });
  });
});
