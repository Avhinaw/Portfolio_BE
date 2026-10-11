import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CallSlot } from '../../src/models/CallSlot';
import { Meeting } from '../../src/models/Meeting';
import {
  HOST_EMAIL,
  HOST_PASSWORD,
  bearer,
  createMeeting,
  loginHost,
  startTestServer,
  type TestServer,
} from '../helpers/server';
import { restoreFetch } from '../helpers/telegram';

let server: TestServer;
let token: string;

beforeAll(async () => {
  server = await startTestServer({ MAX_ACTIVE_CALLS: '1' });
  token = await loginHost(server.app);
});
afterAll(async () => {
  await server.stop();
});
afterEach(async () => {
  restoreFetch();
  // Reset to a clean slate between tests.
  await Meeting.deleteMany({});
  await CallSlot.deleteMany({});
});

const accept = (roomId: string) => request(server.app).post(`/api/host/meetings/${roomId}/accept`).set(bearer(token));
const reject = (roomId: string) => request(server.app).post(`/api/host/meetings/${roomId}/reject`).set(bearer(token));
const end = (roomId: string) => request(server.app).post(`/api/host/meetings/${roomId}/end`).set(bearer(token));

describe('host authentication', () => {
  it('rejects every private route without a valid token', async () => {
    const m = await createMeeting(server.app);
    const routes: [string, string][] = [
      ['get', '/api/host/meetings'],
      ['get', `/api/host/meetings/${m.roomId}`],
      ['post', `/api/host/meetings/${m.roomId}/accept`],
      ['post', `/api/host/meetings/${m.roomId}/reject`],
      ['post', `/api/host/meetings/${m.roomId}/end`],
      ['post', '/api/host/auth/logout'],
      ['get', '/api/host/availability'],
      ['post', '/api/host/telegram/test'],
      ['get', '/api/host/ice-servers'],
    ];
    for (const [method, url] of routes) {
      const res = await (request(server.app) as unknown as Record<string, (u: string) => request.Test>)[method]!(url);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    const forged = await request(server.app).get('/api/host/meetings').set(bearer('not.a.jwt-token-at-all'));
    expect(forged.status).toBe(401);
  });

  it('rejects wrong credentials with a generic message', async () => {
    const badPassword = await request(server.app)
      .post('/api/host/auth/login')
      .send({ email: HOST_EMAIL, password: 'wrong password!!' });
    const badEmail = await request(server.app)
      .post('/api/host/auth/login')
      .send({ email: 'someone@else.com', password: HOST_PASSWORD });
    expect(badPassword.status).toBe(401);
    expect(badEmail.status).toBe(401);
    expect(badPassword.body.error).toEqual(badEmail.body.error);
  });

  it('logs in, accesses private routes, and invalidates the session on logout', async () => {
    const t = await loginHost(server.app);
    expect((await request(server.app).get('/api/host/meetings').set(bearer(t))).status).toBe(200);

    const out = await request(server.app).post('/api/host/auth/logout').set(bearer(t));
    expect(out.status).toBe(200);

    const after = await request(server.app).get('/api/host/meetings').set(bearer(t));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('session_revoked');
  });

  it('never returns private fields in host views', async () => {
    const m = await createMeeting(server.app, 'Zed', 'hello');
    const res = await request(server.app).get(`/api/host/meetings/${m.roomId}`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.visitorName).toBe('Zed');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/visitorTokenHash|visitorFingerprint|SocketId|purgeAt|"_id"/);
  });
});

describe('meeting lifecycle', () => {
  it('lists pending meetings and filters by status', async () => {
    await createMeeting(server.app, 'One');
    const two = await createMeeting(server.app, 'Two');
    await reject(two.roomId);
    const all = await request(server.app).get('/api/host/meetings').set(bearer(token));
    expect(all.body.data.meetings).toHaveLength(2);
    const pending = await request(server.app).get('/api/host/meetings?status=pending').set(bearer(token));
    expect(pending.body.data.meetings.map((x: { visitorName: string }) => x.visitorName)).toEqual(['One']);
    expect((await request(server.app).get('/api/host/meetings?status=bogus').set(bearer(token))).status).toBe(400);
  });

  it('accepts then ends a call and records timestamps', async () => {
    const m = await createMeeting(server.app);
    const accepted = await accept(m.roomId);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.status).toBe('accepted');
    expect(accepted.body.data.acceptedAt).toBeTruthy();
    expect(accepted.body.data.startedAt).toBeNull(); // not started until both browsers report connected

    const ended = await end(m.roomId);
    expect(ended.status).toBe(200);
    expect(ended.body.data).toMatchObject({ status: 'ended', endedBy: 'host' });
    expect(await CallSlot.countDocuments({})).toBe(0);
  });

  it('rejects a pending request', async () => {
    const m = await createMeeting(server.app);
    const res = await reject(m.roomId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'rejected', endedBy: 'host' });
    const pub = await request(server.app).get(`/api/meetings/${m.roomId}/status`);
    expect(pub.body.data.status).toBe('rejected');
  });

  it('refuses invalid state transitions with 409', async () => {
    const a = await createMeeting(server.app, 'A');
    expect((await end(a.roomId)).status).toBe(409); // pending -> ended is not allowed
    expect((await accept(a.roomId)).status).toBe(200);
    expect((await accept(a.roomId)).status).toBe(409); // already accepted
    expect((await reject(a.roomId)).status).toBe(409); // accepted -> rejected is not allowed
    expect((await end(a.roomId)).status).toBe(200);
    expect((await end(a.roomId)).status).toBe(409); // already ended
    expect((await accept(a.roomId)).status).toBe(409); // ended -> accepted is not allowed

    const b = await createMeeting(server.app, 'B');
    expect((await reject(b.roomId)).status).toBe(200);
    expect((await accept(b.roomId)).status).toBe(409);
  });

  it('returns 404 for unknown meetings', async () => {
    expect((await accept('z'.repeat(32))).status).toBe(404);
  });

  it('refuses to accept an expired request and marks it expired', async () => {
    const m = await createMeeting(server.app);
    await Meeting.updateOne({ roomId: m.roomId }, { $set: { expiresAt: new Date(Date.now() - 5000) } });
    const res = await accept(m.roomId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('meeting_expired');
    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.status).toBe('expired');
  });

  it('expires an accepted meeting whose call never started', async () => {
    const m = await createMeeting(server.app);
    await accept(m.roomId);
    await Meeting.updateOne({ roomId: m.roomId }, { $set: { acceptedAt: new Date(Date.now() - 10 * 60_000) } });
    const res = await request(server.app).get(`/api/meetings/${m.roomId}/status`);
    expect(res.body.data.status).toBe('expired');
    expect(await CallSlot.countDocuments({})).toBe(0); // slot released
  });
});

describe('concurrency and availability', () => {
  it('lets exactly one of many simultaneous accepts of the SAME meeting succeed', async () => {
    const m = await createMeeting(server.app);
    const results = await Promise.all(Array.from({ length: 8 }, () => accept(m.roomId)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await CallSlot.countDocuments({})).toBe(1);
  });

  it('enforces MAX_ACTIVE_CALLS=1 across DIFFERENT meetings accepted at the same time', async () => {
    const a = await createMeeting(server.app, 'A');
    const b = await createMeeting(server.app, 'B');
    const c = await createMeeting(server.app, 'C');
    const results = await Promise.all([accept(a.roomId), accept(b.roomId), accept(c.roomId)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const losers = results.filter((r) => r.status !== 200);
    expect(losers).toHaveLength(2);
    expect(losers.every((r) => r.status === 409 && r.body.error.code === 'host_busy')).toBe(true);
    expect(await Meeting.countDocuments({ status: 'accepted' })).toBe(1);
    expect(await Meeting.countDocuments({ status: 'pending' })).toBe(2);
  });

  it('frees the slot when the call ends so the next request can be accepted', async () => {
    const a = await createMeeting(server.app, 'A');
    const b = await createMeeting(server.app, 'B');
    expect((await accept(a.roomId)).status).toBe(200);
    expect((await accept(b.roomId)).body.error.code).toBe('host_busy');
    await end(a.roomId);
    expect((await accept(b.roomId)).status).toBe(200);
  });

  it('bulk-rejects pending requests', async () => {
    await createMeeting(server.app, 'A');
    await createMeeting(server.app, 'B');
    const res = await request(server.app).post('/api/host/meetings/bulk/reject-pending').set(bearer(token));
    expect(res.body.data.rejected).toBe(2);
    expect(await Meeting.countDocuments({ status: 'pending' })).toBe(0);
  });

  it('stops new requests while the host is unavailable and resumes afterwards', async () => {
    const off = await request(server.app).put('/api/host/availability').set(bearer(token)).send({ available: false });
    expect(off.status).toBe(200);
    expect(off.body.data.available).toBe(false);

    const pub = await request(server.app).get('/api/availability');
    expect(pub.body.data).toEqual({ available: false, busy: false });
    const blocked = await request(server.app).post('/api/meetings').send({ visitorName: 'X' });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('host_unavailable');

    await request(server.app).put('/api/host/availability').set(bearer(token)).send({ available: true });
    expect((await request(server.app).post('/api/meetings').send({ visitorName: 'X' })).status).toBe(201);
  });
});
