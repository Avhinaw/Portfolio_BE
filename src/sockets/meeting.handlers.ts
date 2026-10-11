import type { Server, Socket } from 'socket.io';
import { z, type ZodTypeAny } from 'zod';
import { getEnv } from '../config/env';
import {
  endMeeting,
  getAvailability,
  getPublicStatus,
  listHostMeetings,
  markConnected,
  registerSocket,
  requireSignalingState,
  toPublicStatus,
  unregisterSocket,
} from '../services/meeting.service';
import { emitToHosts, emitToRole, rooms } from '../services/realtime';
import type { Ack, SocketData, SocketRole } from '../types/socket';
import { AppError, forbidden } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  answerPayload,
  connectionFailedPayload,
  emptyPayload,
  hostJoinRoomPayload,
  icePayload,
  meetingJoinPayload,
  offerPayload,
  roomPayload,
} from '../validators/signaling.validator';

const WINDOW_MS = 10_000;

function createBucket(max: number) {
  let count = 0;
  let resetAt = Date.now() + WINDOW_MS;
  return (): 'ok' | 'limited' | 'abusive' => {
    const now = Date.now();
    if (now > resetAt) {
      count = 0;
      resetAt = now + WINDOW_MS;
    }
    count += 1;
    if (count > max * 3) return 'abusive';
    return count > max ? 'limited' : 'ok';
  };
}

function toAckError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'socket handler failed');
  return { code: 'internal_error', message: 'Internal error' };
}

const other = (role: SocketRole): SocketRole => (role === 'host' ? 'visitor' : 'host');

export function registerMeetingHandlers(io: Server, socket: Socket): void {
  const env = getEnv();
  const data = socket.data as SocketData;
  const bucket = createBucket(env.SOCKET_EVENT_LIMIT_PER_10S);

  // A long-lived host socket must not outlive its access token.
  let expiryTimer: NodeJS.Timeout | undefined;
  if (data.role === 'host' && data.exp) {
    const ms = Math.max(0, data.exp * 1000 - Date.now());
    expiryTimer = setTimeout(() => {
      socket.emit('call:error', { code: 'token_expired', message: 'Access token expired' });
      socket.disconnect(true);
    }, ms);
    expiryTimer.unref();
  }
  if (data.role === 'host' && data.sid) void socket.join(rooms.session(data.sid));

  /** Registers an event with rate limiting, payload validation, ack handling and uniform error reporting. */
  function on<S extends ZodTypeAny>(
    event: string,
    schema: S,
    handler: (payload: z.infer<S>, ack: Ack) => Promise<void> | void,
  ): void {
    socket.on(event, async (...args: unknown[]) => {
      const ackCandidate = args.find((a) => typeof a === 'function');
      const ack: Ack = typeof ackCandidate === 'function' ? (ackCandidate as Ack) : () => undefined;
      const raw = typeof args[0] === 'function' ? {} : (args[0] ?? {});

      const state = bucket();
      if (state === 'abusive') {
        socket.disconnect(true);
        return;
      }
      if (state === 'limited') {
        socket.emit('call:error', { code: 'rate_limited', event, message: 'Too many events' });
        ack({ ok: false, error: { code: 'rate_limited', message: 'Too many events' } });
        return;
      }

      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const error = { code: 'invalid_payload', message: 'Malformed payload' };
        socket.emit('call:error', { ...error, event });
        ack({ ok: false, error });
        return;
      }

      try {
        await handler(parsed.data as z.infer<S>, ack);
      } catch (err) {
        const error = toAckError(err);
        socket.emit('call:error', { ...error, event });
        ack({ ok: false, error });
      }
    });
  }

  /**
   * Authorisation for every meeting-specific event. The caller's role comes from verified handshake data,
   * and the socket must belong to the room it targets (visitor: its single bound room; host: a room it
   * joined through host:join-room, which itself requires an authenticated host).
   * The meeting status is re-read from MongoDB every time.
   */
  async function authorize(roomId: string): Promise<SocketRole> {
    if (data.role === 'visitor') {
      if (data.roomId !== roomId || !socket.rooms.has(rooms.meetingVisitor(roomId))) {
        throw forbidden('wrong_room', 'Not authorized for this meeting');
      }
    } else if (!socket.rooms.has(rooms.meetingHost(roomId))) {
      throw forbidden('wrong_room', 'Not authorized for this meeting');
    }
    await requireSignalingState(roomId);
    return data.role;
  }

  /* ------------------------------ host events ------------------------------ */

  on('host:register', emptyPayload, async (_payload, ack) => {
    if (data.role !== 'host') throw forbidden('host_only', 'Host only');
    await socket.join(rooms.hosts);
    const [pending, availability] = await Promise.all([
      listHostMeetings({ status: 'pending', limit: 50 }),
      getAvailability(),
    ]);
    ack({ ok: true, data: { pending, availability } });
  });

  on('host:join-room', hostJoinRoomPayload, async ({ roomId }, ack) => {
    if (data.role !== 'host') throw forbidden('host_only', 'Host only');
    const meeting = await requireSignalingState(roomId); // must be accepted or in_progress
    await socket.join([rooms.meetingHost(roomId), rooms.meeting(roomId)]);
    if (!data.joinedRooms.includes(roomId)) data.joinedRooms.push(roomId);
    await registerSocket(roomId, 'host', socket.id);
    emitToRole(roomId, 'visitor', 'call:peer-joined', { roomId, role: 'host' });
    ack({ ok: true, data: toPublicStatus(meeting) });
  });

  /* ----------------------------- visitor events ---------------------------- */

  on('meeting:join', meetingJoinPayload, async ({ roomId }, ack) => {
    if (data.role !== 'visitor' || !data.roomId) throw forbidden('visitor_only', 'Visitor only');
    if (roomId && roomId !== data.roomId) throw forbidden('wrong_room', 'Not authorized for this meeting');
    const bound = data.roomId;
    await socket.join([rooms.meetingVisitor(bound), rooms.meeting(bound)]);
    await registerSocket(bound, 'visitor', socket.id);
    const status = await getPublicStatus(bound);
    socket.emit('meeting:status', { ...status, endedBy: null, reason: null });
    emitToHosts('meeting:visitor-connected', { roomId: bound });
    emitToRole(bound, 'host', 'call:peer-joined', { roomId: bound, role: 'visitor' });
    ack({ ok: true, data: status });
  });

  /* ------------------------------ call signaling --------------------------- */

  on('call:ready', roomPayload, async ({ roomId }, ack) => {
    const role = await authorize(roomId);
    if (!data.readyRooms.includes(roomId)) data.readyRooms.push(roomId);
    emitToRole(roomId, other(role), 'call:peer-ready', { roomId, role });

    // The host is always the caller. It is told to create the offer once BOTH sides have local media ready.
    const peers = await io.in(role === 'host' ? rooms.meetingVisitor(roomId) : rooms.meetingHost(roomId)).fetchSockets();
    const peerReady = peers.some((p) => (p.data as SocketData).readyRooms?.includes(roomId));
    if (peerReady) emitToRole(roomId, 'host', 'call:begin', { roomId });
    ack({ ok: true, data: { peerReady } });
  });

  on('call:offer', offerPayload, async ({ roomId, sdp }, ack) => {
    const role = await authorize(roomId);
    if (role !== 'host') throw forbidden('host_only', 'Only the host creates the offer');
    emitToRole(roomId, 'visitor', 'call:offer', { roomId, sdp });
    ack({ ok: true });
  });

  on('call:answer', answerPayload, async ({ roomId, sdp }, ack) => {
    const role = await authorize(roomId);
    if (role !== 'visitor') throw forbidden('visitor_only', 'Only the visitor creates the answer');
    emitToRole(roomId, 'host', 'call:answer', { roomId, sdp });
    ack({ ok: true });
  });

  on('call:ice-candidate', icePayload, async ({ roomId, candidate }, ack) => {
    const role = await authorize(roomId);
    emitToRole(roomId, other(role), 'call:ice-candidate', { roomId, candidate });
    ack({ ok: true });
  });

  /** Each browser reports RTCPeerConnection.connectionState === "connected". Only then does the call start. */
  on('call:connected', roomPayload, async ({ roomId }, ack) => {
    const role = await authorize(roomId);
    const meeting = await markConnected(roomId, role);
    ack({ ok: true, data: { status: meeting.status, startedAt: meeting.startedAt ?? null } });
  });

  on('call:connection-failed', connectionFailedPayload, async ({ roomId, reason }, ack) => {
    const role = await authorize(roomId);
    // Reset readiness so both sides can renegotiate with call:ready.
    data.readyRooms = data.readyRooms.filter((r) => r !== roomId);
    emitToRole(roomId, other(role), 'call:error', {
      code: 'peer_connection_failed',
      message: `The ${role} could not establish the media connection`,
      reason,
      roomId,
    });
    ack({ ok: true });
  });

  on('call:end', roomPayload, async ({ roomId }, ack) => {
    const role = await authorize(roomId);
    await endMeeting(roomId, role); // broadcasts call:ended to both participants
    ack({ ok: true });
  });

  /* ------------------------------- disconnects ----------------------------- */

  socket.on('disconnect', () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    void handleDisconnect().catch((err: unknown) =>
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'disconnect cleanup failed'),
    );
  });

  async function handleDisconnect(): Promise<void> {
    if (data.role === 'visitor' && data.roomId) {
      const roomId = data.roomId;
      const wasRegistered = await unregisterSocket(roomId, 'visitor', socket.id);
      if (wasRegistered) {
        emitToHosts('meeting:visitor-disconnected', { roomId });
        emitToRole(roomId, 'host', 'call:peer-disconnected', { roomId, role: 'visitor' });
      }
      return;
    }
    for (const roomId of data.joinedRooms) {
      const wasRegistered = await unregisterSocket(roomId, 'host', socket.id);
      if (wasRegistered) emitToRole(roomId, 'visitor', 'call:peer-disconnected', { roomId, role: 'host' });
    }
  }
}
