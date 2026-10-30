import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';

describe('API Error Handling and Validation', () => {
  const app = createApp();

  it('POST /api/setup/bootstrap with empty body should return 400 with VALIDATION_ERROR code', async () => {
    const res = await request(app).post('/api/setup/bootstrap').send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error).toHaveProperty('details');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('POST /api/setup/bootstrap with invalid payload should return field-specific error details', async () => {
    const res = await request(app)
      .post('/api/setup/bootstrap')
      .send({
        company: {
          name: '',
          code: '1',
          currency: 'INVALID_CURRENCY',
        },
        superAdmin: {
          fullName: '',
          email: 'not-an-email',
          password: '123',
          confirmPassword: '456',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('superAdmin.email');
    expect(fields).toContain('superAdmin.confirmPassword');
  });

  it('GET /api/nonexistent-route should return 404 or fall through without crashing server', async () => {
    const res = await request(app).get('/api/nonexistent-route');
    expect(res.status).toBe(404);
  });
});
