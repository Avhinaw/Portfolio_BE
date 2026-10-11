import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_ORIGIN, startTestServer, type TestServer } from '../helpers/server';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.stop();
});

describe('HTTP hardening', () => {
  it('sets Helmet security headers and hides the framework', async () => {
    const res = await request(server.app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows only allow-listed origins via CORS', async () => {
    const good = await request(server.app).get('/api/health').set('Origin', ALLOWED_ORIGIN);
    expect(good.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);

    const bad = await request(server.app).get('/api/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await request(server.app)
      .options('/api/meetings')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns sanitized JSON errors (no stack traces) for malformed bodies and unknown routes', async () => {
    const bad = await request(server.app)
      .post('/api/meetings')
      .set('Content-Type', 'application/json')
      .send('{"visitorName": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.(js|ts)|node_modules|SyntaxError/);

    const missing = await request(server.app).get('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.ok).toBe(false);
  });

  it('enforces the request body size limit', async () => {
    const res = await request(server.app)
      .post('/api/meetings')
      .send({ visitorName: 'a', visitorMessage: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('does not accept non-JSON content types as a body', async () => {
    const res = await request(server.app).post('/api/meetings').type('text/plain').send('visitorName=a');
    expect(res.status).toBe(400);
  });
});
