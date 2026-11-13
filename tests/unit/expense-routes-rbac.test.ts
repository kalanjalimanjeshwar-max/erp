import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { prisma } from '../../src/server/db/client.js';
import { AuthService } from '../../src/server/services/auth.service.js';
import { ReceiptStorageService } from '../../src/server/services/receipt-storage.service.js';
import { ExpenseClaimService } from '../../src/server/services/expense-claim.service.js';
import { AuthUser, Role } from '../../src/shared/types.js';

describe('Expense Routes RBAC, Capabilities & Attachment Payload Limit', () => {
  const companyId = '55555555-5555-5555-5555-555555555555';
  const app = createApp();

  const makeUser = (role: Role, idSuffix: string): AuthUser => ({
    id: `user-${idSuffix}`,
    userId: `user-${idSuffix}`,
    companyId,
    email: `${idSuffix}@company.com`,
    fullName: `${role} User`,
    role,
    isActive: true,
    tokenVersion: 1,
  });

  const employeeUser = makeUser('EMPLOYEE', 'emp');
  const viceAdminUser = makeUser('VICE_ADMIN', 'vice');
  const adminUser = makeUser('ADMIN', 'admin');

  const authenticateAs = (user: AuthUser) => {
    vi.spyOn(AuthService, 'verifySessionToken').mockReturnValue({
      userId: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      tokenVersion: user.tokenVersion,
      exp: Date.now() + 60_000,
    });
    vi.spyOn(AuthService, 'validateSessionUser').mockResolvedValue(user);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(prisma.rolePermission, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.employee, 'findFirst').mockResolvedValue({
      id: 'emp-linked-1',
      companyId,
      userId: employeeUser.id,
      fullName: 'Linked Employee',
      employeeCode: 'EMP-100',
    } as any);
  });

  it('1. should return 401 UNAUTHENTICATED when accessing expense routes without session', async () => {
    const res1 = await request(app).get('/api/expenses/claims');
    expect(res1.status).toBe(401);

    const res2 = await request(app).get('/api/expenses/capabilities');
    expect(res2.status).toBe(401);

    const res3 = await request(app).post('/api/expenses/attachments').send({});
    expect(res3.status).toBe(401);
  });

  it('2. should block EMPLOYEE from manager-review, accounts-review, and pay endpoints with 403', async () => {
    authenticateAs(employeeUser);

    const mgrRes = await request(app)
      .post('/api/expenses/claims/claim-1/manager-review')
      .set('Authorization', 'Bearer valid-token')
      .send({ decision: 'APPROVE' });
    expect(mgrRes.status).toBe(403);

    const accRes = await request(app)
      .post('/api/expenses/claims/claim-1/accounts-review')
      .set('Authorization', 'Bearer valid-token')
      .send({ decision: 'APPROVE' });
    expect(accRes.status).toBe(403);

    const payRes = await request(app)
      .post('/api/expenses/claims/claim-1/pay')
      .set('Authorization', 'Bearer valid-token')
      .send({ paymentMethod: 'BANK_TRANSFER' });
    expect(payRes.status).toBe(403);
  });

  it('3. should block VICE_ADMIN without permission overrides from review and payout endpoints with 403', async () => {
    authenticateAs(viceAdminUser);

    const capsRes = await request(app)
      .get('/api/expenses/capabilities')
      .set('Authorization', 'Bearer valid-token');
    expect(capsRes.status).toBe(200);
    expect(capsRes.body.canManagerApprove).toBe(false);
    expect(capsRes.body.canAccountsApprove).toBe(false);

    const mgrRes = await request(app)
      .post('/api/expenses/claims/claim-1/manager-review')
      .set('Authorization', 'Bearer valid-token')
      .send({ decision: 'APPROVE' });
    expect(mgrRes.status).toBe(403);

    const accRes = await request(app)
      .post('/api/expenses/claims/claim-1/accounts-review')
      .set('Authorization', 'Bearer valid-token')
      .send({ decision: 'APPROVE' });
    expect(accRes.status).toBe(403);
  });

  it('4. should return accurate RBAC capabilities for ADMIN', async () => {
    authenticateAs(adminUser);

    const capsRes = await request(app)
      .get('/api/expenses/capabilities')
      .set('Authorization', 'Bearer valid-token');

    expect(capsRes.status).toBe(200);
    expect(capsRes.body).toEqual({
      canManagerApprove: true,
      canAccountsApprove: true,
      canViewAccounting: true,
      canViewCompanyBankAccounts: true,
      canViewEmployees: true,
      currentEmployeeId: 'emp-linked-1',
    });
  });

  it('5. should accept >100KB base64 JSON attachment payloads on /api/expenses/attachments while keeping 100KB limit on other routes', async () => {
    authenticateAs(employeeUser);

    const storeSpy = vi.spyOn(ReceiptStorageService, 'storeReceipt').mockResolvedValue({
      id: 'att-large-1',
      claimId: null,
      companyId,
      fileName: 'large-receipt.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 200000,
      sha256Hash: 'a'.repeat(64),
      uploadedByUserId: employeeUser.id,
      createdAt: new Date().toISOString(),
    });

    // ~200KB PDF buffer -> ~266KB base64 (> 100KB default Express JSON limit)
    const largePdf = Buffer.alloc(200 * 1024, 0x41);
    largePdf[0] = 0x25;
    largePdf[1] = 0x50;
    largePdf[2] = 0x44;
    largePdf[3] = 0x46;
    largePdf[4] = 0x2d;

    const uploadRes = await request(app)
      .post('/api/expenses/attachments')
      .set('Authorization', 'Bearer valid-token')
      .send({
        fileName: 'large-receipt.pdf',
        mimeType: 'application/pdf',
        dataBase64: largePdf.toString('base64'),
      });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.id).toBe('att-large-1');
    expect(storeSpy).toHaveBeenCalledTimes(1);

    // Other JSON endpoints must still reject >100KB payloads with 413
    const createSpy = vi.spyOn(ExpenseClaimService, 'createClaim');
    const oversizedClaimRes = await request(app)
      .post('/api/expenses/claims')
      .set('Authorization', 'Bearer valid-token')
      .send({
        title: 'Oversized',
        description: 'x'.repeat(200 * 1024),
        originalExpenseDate: '2026-03-01',
        lines: [],
      });

    expect(oversizedClaimRes.status).toBe(413);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
