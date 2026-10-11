import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST_EMAIL, HOST_PASSWORD, startTestServer, type TestServer } from '../helpers/server';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    MEETING_CREATE_RATE_LIMIT_MAX: '3',
    MAX_PENDING_PER_VISITOR: '2',
    LOGIN_RATE_LIMIT_MAX: '3',
  });
});
afterAll(async () => {
  await server.stop();
});

describe('abuse protection', () => {
  it('caps concurrent pending requests per visitor, then rate-limits meeting creation', async () => {
    const send = () => request(server.app).post('/api/meetings').send({ visitorName: 'Spammer' });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);

    const duplicate = await send();
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('duplicate_pending');

    const limited = await send(); // 4th request inside the window (limit = 3)
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(limited.headers['ratelimit']).toBeDefined(); // draft-7 standard header
  });

  it('blocks brute-force logins after repeated failures, even with the right password afterwards', async () => {
    const attempt = (password: string) =>
      request(server.app).post('/api/host/auth/login').send({ email: HOST_EMAIL, password });

    for (let i = 0; i < 3; i += 1) expect((await attempt(`wrong-password-${i}`)).status).toBe(401);
    const blocked = await attempt(HOST_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });
});
