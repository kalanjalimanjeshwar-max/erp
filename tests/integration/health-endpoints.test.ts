import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';

describe('Health & Diagnostics API Endpoints', () => {
  const app = createApp();

  it('GET /api/health should return 200 with process health data', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('uptimeSeconds');
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('GET /api/ready should return structured readiness response without leaking credentials', async () => {
    const res = await request(app).get('/api/ready');

    // May be 200 (if DB connected) or 503 (if DB offline in test container), but response shape must be strictly validated
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('checks');
    expect(res.body.checks).toHaveProperty('postgres');
    expect(res.body.checks.postgres).toHaveProperty('database', 'PostgreSQL');

    // Critical check: Ensure no database passwords or auth strings are leaked in details or error
    const rawBody = JSON.stringify(res.body);
    expect(rawBody).not.toMatch(/password/i);
    expect(rawBody).not.toMatch(/postgresql:\/\/[^@\s]+@/i);
  });
});
