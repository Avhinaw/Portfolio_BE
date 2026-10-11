import request from 'supertest';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Meeting } from '../../src/models/Meeting';
import { CallSlot } from '../../src/models/CallSlot';
import { sweep } from '../../src/services/meeting.service';
import {
  VALID_CANDIDATE,
  VALID_SDP,
  bearer,
  connectSocket,
  createMeeting,
  emitAck,
  loginHost,
  neverReceives,
  nextEvent,
  startTestServer,
  waitConnectError,
  waitConnected,
  waitFor,
  type CreatedMeeting,
  type TestServer,
} from '../helpers/server';
import { restoreFetch } from '../helpers/telegram';

let server: TestServer;
let hostToken: string;
const open: Socket[] = [];

beforeAll(async () => {
  server = await startTestServer({ MAX_ACTIVE_CALLS: '2', RECONNECT_GRACE_SECONDS: '5' });
  hostToken = await loginHost(server.app);
});
afterAll(async () => {
  await server.stop();
});
afterEach(async () => {
  restoreFetch();
  while (open.length) open.pop()?.disconnect();
  await Meeting.deleteMany({});
  await CallSlot.deleteMany({});
});

async function visitorSocket(m: CreatedMeeting): Promise<Socket> {
  const s = connectSocket(server.baseUrl, { role: 'visitor', roomId: m.roomId, visitorToken: m.visitorToken });
  open.push(s);
  await waitConnected(s);
  return s;
}
async function hostSocket(token = hostToken): Promise<Socket> {
  const s = connectSocket(server.baseUrl, { role: 'host', token });
  open.push(s);
  await waitConnected(s);
  return s;
}
const acceptViaRest = (roomId: string) =>
  request(server.app).post(`/api/host/meetings/${roomId}/accept`).set(bearer(hostToken));

/** Creates + accepts a meeting and returns both signaling-ready sockets. */
async function acceptedCall() {
  const m = await createMeeting(server.app, 'Caller');
  const host = await hostSocket();
  const visitor = await visitorSocket(m);
  expect((await emitAck(host, 'host:register')).ok).toBe(true);
  expect((await emitAck(visitor, 'meeting:join')).ok).toBe(true);
  expect((await acceptViaRest(m.roomId)).status).toBe(200);
  expect((await emitAck(host, 'host:join-room', { roomId: m.roomId })).ok).toBe(true);
  return { m, host, visitor };
}

describe('socket authentication', () => {
  it('rejects connections without credentials, with garbage, or with a bad visitor token', async () => {
    const m = await createMeeting(server.app);
    for (const auth of [
      {},
      { role: 'host' },
      { role: 'host', token: 'definitely-not-a-valid-token' },
      { role: 'host', isHost: true },
      { role: 'visitor', roomId: m.roomId, visitorToken: 'x'.repeat(43) },
      { role: 'visitor', roomId: 'short', visitorToken: m.visitorToken },
    ]) {
      const s = connectSocket(server.baseUrl, auth);
      open.push(s);
      const err = await waitConnectError(s);
      expect(err.message).toBe('unauthorized');
    }
  });

  it('rejects a host token after logout and disconnects live host sockets on logout', async () => {
    const t = await loginHost(server.app);
    const live = await hostSocket(t);
    const closed = nextEvent(live, 'disconnect');
    await request(server.app).post('/api/host/auth/logout').set(bearer(t));
    await closed;

    const again = connectSocket(server.baseUrl, { role: 'host', token: t });
    open.push(again);
    expect((await waitConnectError(again)).message).toBe('unauthorized');
  });

  it('does not let a visitor act as host or join another meeting', async () => {
    const a = await createMeeting(server.app, 'A');
    const b = await createMeeting(server.app, 'B');
    const visitorA = await visitorSocket(a);
    expect((await emitAck(visitorA, 'host:register')).error?.code).toBe('host_only');
    expect((await emitAck(visitorA, 'host:join-room', { roomId: b.roomId })).error?.code).toBe('host_only');
    expect((await emitAck(visitorA, 'meeting:join', { roomId: b.roomId })).error?.code).toBe('wrong_room');
  });
});

describe('meeting status in real time', () => {
  it('notifies the host of new requests and the visitor of accept / reject / cancel', async () => {
    const host = await hostSocket();
    await emitAck(host, 'host:register');

    const incoming = nextEvent<{ visitorName: string; roomId: string }>(host, 'meeting:new');
    const m = await createMeeting(server.app, 'Realtime');
    expect((await incoming).visitorName).toBe('Realtime');

    const visitor = await visitorSocket(m);
    await emitAck(visitor, 'meeting:join');
    const accepted = nextEvent<{ status: string }>(visitor, 'meeting:accepted');
    await acceptViaRest(m.roomId);
    expect((await accepted).status).toBe('accepted');

    const m2 = await createMeeting(server.app, 'Rejected');
    const v2 = await visitorSocket(m2);
    await emitAck(v2, 'meeting:join');
    const rejected = nextEvent<{ status: string }>(v2, 'meeting:rejected');
    await request(server.app).post(`/api/host/meetings/${m2.roomId}/reject`).set(bearer(hostToken));
    expect((await rejected).status).toBe('rejected');

    const m3 = await createMeeting(server.app, 'Cancelled');
    const v3 = await visitorSocket(m3);
    await emitAck(v3, 'meeting:join');
    const cancelled = nextEvent<{ status: string }>(v3, 'meeting:cancelled');
    await request(server.app).post(`/api/meetings/${m3.roomId}/cancel`).set('X-Visitor-Token', m3.visitorToken);
    expect((await cancelled).status).toBe('cancelled');
  });
});

describe('WebRTC signaling', () => {
  it('runs the full flow: ready -> begin -> offer -> answer -> ICE -> connected -> in_progress -> ended', async () => {
    const { m, host, visitor } = await acceptedCall();

    const peerReady = nextEvent(host, 'call:peer-ready');
    expect((await emitAck(visitor, 'call:ready', { roomId: m.roomId })).ok).toBe(true);
    await peerReady;
    const begin = nextEvent(host, 'call:begin');
    expect((await emitAck(host, 'call:ready', { roomId: m.roomId })).ok).toBe(true);
    await begin; // host (the caller) is told to create the offer once both sides are ready

    const gotOffer = nextEvent<{ sdp: { type: string } }>(visitor, 'call:offer');
    expect((await emitAck(host, 'call:offer', { roomId: m.roomId, sdp: VALID_SDP('offer') })).ok).toBe(true);
    expect((await gotOffer).sdp.type).toBe('offer');

    const gotAnswer = nextEvent<{ sdp: { type: string } }>(host, 'call:answer');
    expect((await emitAck(visitor, 'call:answer', { roomId: m.roomId, sdp: VALID_SDP('answer') })).ok).toBe(true);
    expect((await gotAnswer).sdp.type).toBe('answer');

    const hostCandidate = nextEvent<{ candidate: { candidate: string } }>(host, 'call:ice-candidate');
    await emitAck(visitor, 'call:ice-candidate', { roomId: m.roomId, candidate: VALID_CANDIDATE });
    expect((await hostCandidate).candidate.candidate).toBe(VALID_CANDIDATE.candidate);
    const visitorCandidate = nextEvent(visitor, 'call:ice-candidate');
    await emitAck(host, 'call:ice-candidate', { roomId: m.roomId, candidate: VALID_CANDIDATE });
    await visitorCandidate;

    // One side reporting "connected" is NOT enough to start the call.
    await emitAck(host, 'call:connected', { roomId: m.roomId });
    let status = await request(server.app).get(`/api/meetings/${m.roomId}/status`);
    expect(status.body.data.status).toBe('accepted');
    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.startedAt).toBeUndefined();

    const started = nextEvent(visitor, 'call:started');
    await emitAck(visitor, 'call:connected', { roomId: m.roomId });
    await started;
    status = await request(server.app).get(`/api/meetings/${m.roomId}/status`);
    expect(status.body.data.status).toBe('in_progress');
    const stored = await Meeting.findOne({ roomId: m.roomId }).lean();
    expect(stored?.startedAt).toBeInstanceOf(Date);
    expect(stored?.maxEndsAt).toBeInstanceOf(Date);

    const hostEnded = nextEvent<{ endedBy: string }>(host, 'call:ended');
    const visitorEnded = nextEvent<{ endedBy: string }>(visitor, 'call:ended');
    const end = await request(server.app).post(`/api/host/meetings/${m.roomId}/end`).set(bearer(hostToken));
    expect(end.status).toBe(200);
    expect((await hostEnded).endedBy).toBe('host');
    expect((await visitorEnded).endedBy).toBe('host');

    // Signaling is refused once the meeting is over.
    const late = await emitAck(host, 'call:ice-candidate', { roomId: m.roomId, candidate: VALID_CANDIDATE });
    expect(late.error?.code).toBe('invalid_state');
  });

  it('requests one offer when both participants become ready, even if ready is repeated', async () => {
    const { m, host, visitor } = await acceptedCall();
    await emitAck(visitor, 'call:ready', { roomId: m.roomId });
    const begin = nextEvent(host, 'call:begin');
    await emitAck(host, 'call:ready', { roomId: m.roomId });
    await begin;

    const duplicateBegin = neverReceives(host, 'call:begin');
    await emitAck(visitor, 'call:ready', { roomId: m.roomId });
    await emitAck(host, 'call:ready', { roomId: m.roomId });
    expect(await duplicateBegin).toBe(true);
  });

  it('refuses signaling while the meeting is still pending', async () => {
    const m = await createMeeting(server.app);
    const visitor = await visitorSocket(m);
    await emitAck(visitor, 'meeting:join');
    const res = await emitAck(visitor, 'call:ready', { roomId: m.roomId });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('invalid_state');
  });

  it('blocks cross-room signaling: a visitor cannot send to or read another meeting', async () => {
    const a = await acceptedCall();
    const b = await acceptedCall();

    const leak = neverReceives(b.host, 'call:ice-candidate');
    const res = await emitAck(a.visitor, 'call:ice-candidate', { roomId: b.m.roomId, candidate: VALID_CANDIDATE });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('wrong_room');
    expect(await leak).toBe(true);

    // A visitor cannot end someone else's call either.
    expect((await emitAck(a.visitor, 'call:end', { roomId: b.m.roomId })).error?.code).toBe('wrong_room');
    expect((await Meeting.findOne({ roomId: b.m.roomId }).lean())?.status).toBe('accepted');
  });

  it('lets only the host join a room, and only accepted/in_progress rooms', async () => {
    const m = await createMeeting(server.app);
    const host = await hostSocket();
    const pendingJoin = await emitAck(host, 'host:join-room', { roomId: m.roomId });
    expect(pendingJoin.error?.code).toBe('invalid_state');
    const notJoined = await emitAck(host, 'call:offer', { roomId: m.roomId, sdp: VALID_SDP('offer') });
    expect(notJoined.error?.code).toBe('wrong_room');
  });

  it('enforces roles: only the host sends offers, only the visitor sends answers', async () => {
    const { m, host, visitor } = await acceptedCall();
    expect((await emitAck(visitor, 'call:offer', { roomId: m.roomId, sdp: VALID_SDP('offer') })).error?.code).toBe('host_only');
    expect((await emitAck(host, 'call:answer', { roomId: m.roomId, sdp: VALID_SDP('answer') })).error?.code).toBe('visitor_only');
  });

  it.each([
    ['missing sdp', { type: 'offer' }],
    ['wrong type', { type: 'answer', sdp: 'v=0\r\n' }],
    ['not an SDP document', { type: 'offer', sdp: 'hello' }],
    ['oversized sdp', { type: 'offer', sdp: `v=0\r\n${'a'.repeat(25_000)}` }],
    ['extra field', { type: 'offer', sdp: 'v=0\r\n', evil: true }],
    ['non-object', 'offer'],
  ])('rejects malformed offer payloads: %s', async (_label, sdp) => {
    const { m, host, visitor } = await acceptedCall();
    const leak = neverReceives(visitor, 'call:offer');
    const res = await emitAck(host, 'call:offer', { roomId: m.roomId, sdp });
    expect(res.error?.code).toBe('invalid_payload');
    expect(await leak).toBe(true);
  });

  it('rejects malformed ICE candidates and room ids', async () => {
    const { m, host } = await acceptedCall();
    const badCandidate = await emitAck(host, 'call:ice-candidate', {
      roomId: m.roomId,
      candidate: { candidate: 123, sdpMLineIndex: -5 },
    });
    expect(badCandidate.error?.code).toBe('invalid_payload');
    const badRoom = await emitAck(host, 'call:ice-candidate', { roomId: '../../etc', candidate: VALID_CANDIDATE });
    expect(badRoom.error?.code).toBe('invalid_payload');
    const noPayload = await emitAck(host, 'call:ice-candidate');
    expect(noPayload.error?.code).toBe('invalid_payload');
  });

  it('rate-limits event floods per socket', async () => {
    const m = await createMeeting(server.app, 'Flood');
    const visitor = await visitorSocket(m);
    await emitAck(visitor, 'meeting:join');
    const limit = server.env.SOCKET_EVENT_LIMIT_PER_10S;
    const results = await Promise.all(
      Array.from({ length: limit + 20 }, () => emitAck(visitor, 'call:ready', { roomId: m.roomId })),
    );
    expect(results.some((r) => r.error?.code === 'rate_limited')).toBe(true);
  });

  it('forwards a reported connection failure to the peer without ending the meeting', async () => {
    const { m, host, visitor } = await acceptedCall();
    const err = nextEvent<{ code: string; reason: string }>(visitor, 'call:error');
    await emitAck(host, 'call:connection-failed', { roomId: m.roomId, reason: 'ice_failed' });
    expect(await err).toMatchObject({ code: 'peer_connection_failed', reason: 'ice_failed' });
    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.status).toBe('accepted');
  });

  it('lets the visitor end the call and records endedBy=visitor', async () => {
    const { m, host, visitor } = await acceptedCall();
    const hostEnded = nextEvent<{ endedBy: string }>(host, 'call:ended');
    expect((await emitAck(visitor, 'call:end', { roomId: m.roomId })).ok).toBe(true);
    expect((await hostEnded).endedBy).toBe('visitor');
    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.endedBy).toBe('visitor');
  });
});

describe('disconnect behaviour', () => {
  it('replaces a participant socket on reconnect and disconnects the stale socket', async () => {
    const { m, visitor } = await acceptedCall();
    const disconnected = nextEvent(visitor, 'disconnect');
    const replacement = await visitorSocket(m);
    expect((await emitAck(replacement, 'meeting:join')).ok).toBe(true);
    await disconnected;

    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.visitorSocketId).toBe(replacement.id);
    expect(visitor.connected).toBe(false);
  });

  it('notifies the host when the visitor disconnects and clears the transient socket reference', async () => {
    const { m, host, visitor } = await acceptedCall();
    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.visitorSocketId).toBe(visitor.id);

    const dashboard = nextEvent<{ roomId: string }>(host, 'meeting:visitor-disconnected');
    const peer = nextEvent<{ role: string }>(host, 'call:peer-disconnected');
    visitor.disconnect();
    expect((await dashboard).roomId).toBe(m.roomId);
    expect((await peer).role).toBe('visitor');

    const stored = await waitFor(async () => {
      const doc = await Meeting.findOne({ roomId: m.roomId }).lean();
      return doc && !doc.visitorSocketId && doc.peerLostAt ? doc : undefined;
    });
    expect(stored.status).toBe('accepted'); // not ended: the visitor may reconnect
    expect(stored.peerLostAt).toBeInstanceOf(Date);
  });

  it('notifies the visitor when the host disconnects', async () => {
    const { host, visitor } = await acceptedCall();
    const gone = nextEvent<{ role: string }>(visitor, 'call:peer-disconnected');
    host.disconnect();
    expect((await gone).role).toBe('host');
  });

  it('does not clobber a newer connection when an old socket disconnects late', async () => {
    const { m, visitor } = await acceptedCall();
    const second = await visitorSocket(m);
    await emitAck(second, 'meeting:join');
    visitor.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.visitorSocketId).toBe(second.id);
  });

  it('ends an in-progress call by system after the reconnect grace period', async () => {
    const { m, host, visitor } = await acceptedCall();
    await emitAck(host, 'call:connected', { roomId: m.roomId });
    await emitAck(visitor, 'call:connected', { roomId: m.roomId });
    await waitFor(async () => (await Meeting.findOne({ roomId: m.roomId }).lean())?.status === 'in_progress');

    const ended = nextEvent<{ endedBy: string; reason: string }>(host, 'call:ended', 5000);
    visitor.disconnect();
    await waitFor(async () => (await Meeting.findOne({ roomId: m.roomId }).lean())?.peerLostAt);
    // Fast-forward the grace period instead of sleeping, then let the sweeper logic run.
    await Meeting.updateOne({ roomId: m.roomId }, { $set: { peerLostAt: new Date(Date.now() - 60_000) } });
    await sweep();
    const payload = await ended;
    expect(payload).toMatchObject({ endedBy: 'system', reason: 'peer_disconnected' });
    expect(await CallSlot.countDocuments({})).toBe(0);
  });

  it('ends calls that exceed the duration limit', async () => {
    const { m, host, visitor } = await acceptedCall();
    await emitAck(host, 'call:connected', { roomId: m.roomId });
    await emitAck(visitor, 'call:connected', { roomId: m.roomId });
    await waitFor(async () => (await Meeting.findOne({ roomId: m.roomId }).lean())?.status === 'in_progress');
    await Meeting.updateOne({ roomId: m.roomId }, { $set: { maxEndsAt: new Date(Date.now() - 1000) } });
    const ended = nextEvent<{ reason: string }>(visitor, 'call:ended');
    await sweep();
    expect((await ended).reason).toBe('duration_limit');
  });
});
