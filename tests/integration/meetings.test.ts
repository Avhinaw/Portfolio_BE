import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Meeting } from '../../src/models/Meeting';
import { createMeeting, startTestServer, waitFor, type TestServer } from '../helpers/server';
import { mockTelegram, restoreFetch, telegramOk } from '../helpers/telegram';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.stop();
});
afterEach(() => restoreFetch());

describe('GET /api/health', () => {
  it('reports database connectivity without leaking infrastructure details', async () => {
    const res = await request(server.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', database: 'up' });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/mongodb:|127\.0\.0\.1|password/i);
  });
});

describe('POST /api/meetings', () => {
  it('creates and persists a pending meeting with an unguessable room id and one-time visitor token', async () => {
    mockTelegram(() => telegramOk());
    const res = await request(server.app)
      .post('/api/meetings')
      .send({ visitorName: '  John   Doe ', visitorMessage: 'I would like to discuss a project.' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.body.data;
    expect(data.roomId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(data.visitorToken.length).toBeGreaterThanOrEqual(40);
    expect(data.status).toBe('pending');
    expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(Object.keys(data).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'roomId', 'status', 'visitorToken']);

    const stored = await Meeting.findOne({ roomId: data.roomId }).select('+visitorTokenHash').lean();
    expect(stored?.visitorName).toBe('John Doe'); // sanitised
    expect(stored?.status).toBe('pending');
    expect(stored?.visitorTokenHash).toBeDefined();
    expect(stored?.visitorTokenHash).not.toBe(data.visitorToken); // only a hash is stored
    expect(stored?.purgeAt).toBeUndefined(); // pending meetings are never TTL-deleted
  });

  it.each([
    ['missing name', {}],
    ['empty name', { visitorName: '   ' }],
    ['name too long', { visitorName: 'x'.repeat(81) }],
    ['message too long', { visitorName: 'a', visitorMessage: 'y'.repeat(501) }],
    ['unknown field', { visitorName: 'a', isHost: true }],
    ['non-string name', { visitorName: 123 }],
    ['NoSQL operator injection', { visitorName: { $ne: null } }],
  ])('rejects invalid input: %s', async (_label, body) => {
    const res = await request(server.app).post('/api/meetings').send(body);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('strips control and invisible characters from visitor text', async () => {
    const res = await request(server.app)
      .post('/api/meetings')
      .send({ visitorName: 'Ann\u0000\u202Ee', visitorMessage: 'hi\u200Bthere\nnew line' });
    expect(res.status).toBe(201);
    const stored = await Meeting.findOne({ roomId: res.body.data.roomId }).lean();
    expect(stored?.visitorName).toBe('Ann e');
    expect(stored?.visitorMessage).toBe('hi there new line');
  });

  it('sends a Telegram notification containing the visitor details', async () => {
    const mock = mockTelegram(() => telegramOk(99));
    const created = await createMeeting(server.app, 'Grace', 'Let us talk');

    await waitFor(async () => {
      const m = await Meeting.findOne({ roomId: created.roomId }).lean();
      return m?.notification.status === 'sent' ? m : undefined;
    });

    const calls = mock.mock.calls as [string, RequestInit][];
    const match = calls.find(([, init]) => String(init.body).includes('Visitor: Grace'));
    expect(match).toBeDefined();
    const [url, init] = match as [string, RequestInit];
    expect(url).toContain('/sendMessage');
    const body = JSON.parse(String(init.body)) as { text: string; chat_id: string };
    expect(body.chat_id).toBe('42');
    expect(body.text).toContain('Visitor: Grace');
    expect(body.text).toContain('Message: Let us talk');
    expect(body.text).toContain('https://host.example.com');
    expect(body.text).not.toContain(created.visitorToken);
  });
});

describe('GET /api/meetings/:roomId/status', () => {
  it('returns only public-safe fields', async () => {
    mockTelegram(() => telegramOk());
    const created = await createMeeting(server.app, 'Visitor');
    const res = await request(server.app).get(`/api/meetings/${created.roomId}/status`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['acceptedAt', 'createdAt', 'endedAt', 'expiresAt', 'roomId', 'status'].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain('Visitor');
  });

  it('returns 404 for unknown rooms and 400 for malformed ids', async () => {
    expect((await request(server.app).get(`/api/meetings/${'a'.repeat(32)}/status`)).status).toBe(404);
    expect((await request(server.app).get('/api/meetings/not-a-room/status')).status).toBe(400);
  });

  it('lazily expires pending meetings whose deadline passed', async () => {
    mockTelegram(() => telegramOk());
    const created = await createMeeting(server.app);
    await Meeting.updateOne({ roomId: created.roomId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(server.app).get(`/api/meetings/${created.roomId}/status`);
    expect(res.body.data.status).toBe('expired');
    const stored = await Meeting.findOne({ roomId: created.roomId }).lean();
    expect(stored?.endedBy).toBe('system');
    expect(stored?.purgeAt).toBeInstanceOf(Date); // terminal: eligible for TTL cleanup
  });
});

describe('POST /api/meetings/:roomId/cancel', () => {
  it('rejects missing or wrong visitor credentials, including a valid token for another meeting', async () => {
    mockTelegram(() => telegramOk());
    const a = await createMeeting(server.app, 'A');
    const b = await createMeeting(server.app, 'B');

    const none = await request(server.app).post(`/api/meetings/${a.roomId}/cancel`);
    expect(none.status).toBe(401);

    const wrong = await request(server.app)
      .post(`/api/meetings/${a.roomId}/cancel`)
      .set('X-Visitor-Token', 'x'.repeat(43));
    expect(wrong.status).toBe(403);

    const crossMeeting = await request(server.app)
      .post(`/api/meetings/${a.roomId}/cancel`)
      .set('X-Visitor-Token', b.visitorToken);
    expect(crossMeeting.status).toBe(403);

    expect((await Meeting.findOne({ roomId: a.roomId }).lean())?.status).toBe('pending');
  });

  it('lets the owner cancel once; a second cancel is an invalid transition', async () => {
    mockTelegram(() => telegramOk());
    const created = await createMeeting(server.app);
    const first = await request(server.app)
      .post(`/api/meetings/${created.roomId}/cancel`)
      .set('X-Visitor-Token', created.visitorToken);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('cancelled');

    const second = await request(server.app)
      .post(`/api/meetings/${created.roomId}/cancel`)
      .set('Authorization', `Bearer ${created.visitorToken}`);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('invalid_state');
  });
});
