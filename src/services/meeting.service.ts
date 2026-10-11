import { getEnv } from '../config/env';
import { CallSlot } from '../models/CallSlot';
import { HOST_STATE_ID, HostState } from '../models/HostState';
import { Meeting, type EndedBy, type MeetingDoc, type MeetingStatus } from '../models/Meeting';
import { conflict, forbidden, notFound, unavailable } from '../utils/errors';
import { logger } from '../utils/logger';
import { generateRoomId, generateVisitorToken, hashToken, safeEqualHex } from '../utils/roomId';
import { dispatchNotification } from './notification.service';
import { emitToHosts, emitToMeeting } from './realtime';
import { ACTIVE_STATUSES, TERMINAL_STATUSES, allowedFrom } from './meeting.state';

/* ----------------------------------------------------------------------------------------------
 * Views (what leaves the server). Internal ids, token hashes, socket ids and fingerprints never do.
 * -------------------------------------------------------------------------------------------- */

export interface PublicMeetingStatus {
  roomId: string;
  status: MeetingStatus;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  endedAt: Date | null;
}

export function toPublicStatus(m: MeetingDoc): PublicMeetingStatus {
  return {
    roomId: m.roomId,
    status: m.status,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    acceptedAt: m.acceptedAt ?? null,
    endedAt: m.endedAt ?? null,
  };
}

export function toHostView(m: MeetingDoc) {
  return {
    roomId: m.roomId,
    visitorName: m.visitorName,
    visitorMessage: m.visitorMessage ?? null,
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    expiresAt: m.expiresAt,
    acceptedAt: m.acceptedAt ?? null,
    startedAt: m.startedAt ?? null,
    endedAt: m.endedAt ?? null,
    endedBy: m.endedBy ?? null,
    maxEndsAt: m.maxEndsAt ?? null,
    visitorOnline: Boolean(m.visitorSocketId),
    notification: { status: m.notification.status, attempts: m.notification.attempts },
  };
}

/* ----------------------------------------------------------------------------------------------
 * Realtime fan-out
 * -------------------------------------------------------------------------------------------- */

const STATUS_EVENTS: Partial<Record<MeetingStatus, string>> = {
  accepted: 'meeting:accepted',
  rejected: 'meeting:rejected',
  expired: 'meeting:expired',
  cancelled: 'meeting:cancelled',
  in_progress: 'call:started',
  ended: 'call:ended',
};

function publishTransition(m: MeetingDoc, reason?: string): void {
  const payload = { ...toPublicStatus(m), endedBy: m.endedBy ?? null, reason: reason ?? null };
  emitToMeeting(m.roomId, 'meeting:status', payload);
  const specific = STATUS_EVENTS[m.status];
  if (specific) emitToMeeting(m.roomId, specific, payload);
  emitToHosts('meeting:updated', toHostView(m));
}

/* ----------------------------------------------------------------------------------------------
 * Core: atomic conditional transition
 * -------------------------------------------------------------------------------------------- */

interface TransitionOptions {
  set?: Record<string, unknown>;
  unset?: string[];
  /** Extra precondition, e.g. { expiresAt: { $gt: now } }. */
  where?: Record<string, unknown>;
  reason?: string;
  /** Set false for silent internal transitions. */
  publish?: boolean;
}

/**
 * Moves a meeting to `to` only if its current status permits that transition (see meeting.state.ts) and
 * the extra precondition holds. Implemented as ONE findOneAndUpdate, so concurrent callers cannot both win.
 * Returns the updated document, or null if the precondition failed.
 */
async function transition(roomId: string, to: MeetingStatus, options: TransitionOptions = {}): Promise<MeetingDoc | null> {
  const env = getEnv();
  const set: Record<string, unknown> = { status: to, ...options.set };
  if (TERMINAL_STATUSES.includes(to)) {
    set.purgeAt = new Date(Date.now() + env.MEETING_RETENTION_DAYS * 86_400_000);
  }
  const unset: Record<string, 1> = {};
  for (const key of options.unset ?? []) unset[key] = 1;
  if (TERMINAL_STATUSES.includes(to)) {
    unset.hostSocketId = 1;
    unset.visitorSocketId = 1;
    unset.peerLostAt = 1;
  }

  const updated = await Meeting.findOneAndUpdate(
    { ...options.where, roomId, status: { $in: allowedFrom(to) } },
    { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
    { new: true },
  ).lean<MeetingDoc>();

  if (!updated) return null;
  if (TERMINAL_STATUSES.includes(to)) await CallSlot.deleteMany({ roomId });
  if (options.publish !== false) publishTransition(updated, options.reason);
  return updated;
}

async function findByRoomId(roomId: string): Promise<MeetingDoc | null> {
  return Meeting.findOne({ roomId }).lean<MeetingDoc>();
}

/**
 * Applies time-based transitions lazily (also done by the sweeper):
 *  - pending past expiresAt                         -> expired
 *  - accepted that never started within the timeout -> expired
 *  - in_progress past the duration limit            -> ended (system)
 *  - in_progress whose peer has been gone too long  -> ended (system)
 */
export async function applyTimeouts(m: MeetingDoc): Promise<MeetingDoc> {
  const env = getEnv();
  const now = Date.now();
  let next: MeetingDoc | null = null;

  if (m.status === 'pending' && m.expiresAt.getTime() <= now) {
    next = await transition(m.roomId, 'expired', {
      set: { endedAt: new Date(), endedBy: 'system' satisfies EndedBy },
      where: { expiresAt: { $lte: new Date(now) } },
      reason: 'request_timeout',
    });
  } else if (
    m.status === 'accepted' &&
    m.acceptedAt &&
    m.acceptedAt.getTime() + env.ACCEPTED_START_TIMEOUT_SECONDS * 1000 <= now
  ) {
    next = await transition(m.roomId, 'expired', {
      set: { endedAt: new Date(), endedBy: 'system' satisfies EndedBy },
      where: { acceptedAt: { $lte: new Date(now - env.ACCEPTED_START_TIMEOUT_SECONDS * 1000) } },
      reason: 'call_not_started',
    });
  } else if (m.status === 'in_progress') {
    if (m.maxEndsAt && m.maxEndsAt.getTime() <= now) {
      next = await transition(m.roomId, 'ended', {
        set: { endedAt: new Date(), endedBy: 'system' satisfies EndedBy },
        where: { maxEndsAt: { $lte: new Date(now) } },
        reason: 'duration_limit',
      });
    } else if (m.peerLostAt && m.peerLostAt.getTime() + env.RECONNECT_GRACE_SECONDS * 1000 <= now) {
      next = await transition(m.roomId, 'ended', {
        set: { endedAt: new Date(), endedBy: 'system' satisfies EndedBy },
        where: { peerLostAt: { $lte: new Date(now - env.RECONNECT_GRACE_SECONDS * 1000) } },
        reason: 'peer_disconnected',
      });
    }
  }

  if (next) return next;
  // Either nothing was due, or another worker won the race: return the freshest state.
  return (await findByRoomId(m.roomId)) ?? m;
}

/* ----------------------------------------------------------------------------------------------
 * Host availability and call slots
 * -------------------------------------------------------------------------------------------- */

export async function getAvailability() {
  const env = getEnv();
  const [state, activeCalls, pendingCount] = await Promise.all([
    HostState.findById(HOST_STATE_ID).lean(),
    CallSlot.countDocuments({}),
    Meeting.countDocuments({ status: 'pending', expiresAt: { $gt: new Date() } }),
  ]);
  return {
    available: state ? state.available : env.HOST_DEFAULT_AVAILABLE,
    activeCalls,
    maxActiveCalls: env.MAX_ACTIVE_CALLS,
    pendingCount,
  };
}

export async function setAvailability(available: boolean) {
  await HostState.findOneAndUpdate(
    { _id: HOST_STATE_ID },
    { $set: { available, updatedAt: new Date() } },
    { upsert: true },
  );
  const state = await getAvailability();
  emitToHosts('host:availability', state);
  return state;
}

export async function getPublicAvailability() {
  const state = await getAvailability();
  return { available: state.available, busy: state.activeCalls >= state.maxActiveCalls };
}

function isDuplicateKey(err: unknown): err is { code: number; keyPattern?: Record<string, number> } {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/**
 * Acquires one of MAX_ACTIVE_CALLS slots atomically via unique indexes. Works across multiple backend
 * instances because the arbiter is MongoDB, not process memory.
 */
async function acquireSlot(roomId: string): Promise<boolean> {
  const { MAX_ACTIVE_CALLS } = getEnv();
  for (let slot = 0; slot < MAX_ACTIVE_CALLS; slot += 1) {
    try {
      await CallSlot.create({ slot, roomId });
      return true;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Same room already holds a slot: a concurrent accept for this meeting is in flight.
      if (err.keyPattern && 'roomId' in err.keyPattern) {
        throw conflict('invalid_state', 'This meeting is already being accepted');
      }
      // Otherwise the slot number is taken: try the next one.
    }
  }
  return false;
}

/** Deletes slots that no longer belong to an accepted/in_progress meeting (e.g. after a crash). */
export async function reconcileSlots(): Promise<number> {
  const cutoff = new Date(Date.now() - 60_000);
  const slots = await CallSlot.find({ createdAt: { $lte: cutoff } }).lean();
  let removed = 0;
  for (const slot of slots) {
    const active = await Meeting.exists({ roomId: slot.roomId, status: { $in: ACTIVE_STATUSES as MeetingStatus[] } });
    if (!active) {
      await CallSlot.deleteOne({ _id: slot._id });
      removed += 1;
    }
  }
  return removed;
}

/* ----------------------------------------------------------------------------------------------
 * Visitor operations
 * -------------------------------------------------------------------------------------------- */

export interface CreateMeetingInput {
  visitorName: string;
  visitorMessage?: string;
  fingerprint: string;
}

export async function createMeeting(input: CreateMeetingInput) {
  const env = getEnv();
  const availability = await getAvailability();
  if (!availability.available) {
    throw unavailable('host_unavailable', 'The host is not accepting calls right now');
  }

  const now = new Date();
  const [pendingTotal, pendingForVisitor] = await Promise.all([
    Meeting.countDocuments({ status: 'pending', expiresAt: { $gt: now } }),
    Meeting.countDocuments({ status: 'pending', expiresAt: { $gt: now }, visitorFingerprint: input.fingerprint }),
  ]);
  if (pendingTotal >= env.MAX_PENDING_REQUESTS) {
    throw unavailable('queue_full', 'Too many pending call requests. Please try again later');
  }
  if (pendingForVisitor >= env.MAX_PENDING_PER_VISITOR) {
    throw conflict('duplicate_pending', 'You already have a pending call request');
  }

  const visitorToken = generateVisitorToken();
  const expiresAt = new Date(now.getTime() + env.MEETING_REQUEST_TTL_SECONDS * 1000);

  let created: MeetingDoc | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    try {
      const doc = await Meeting.create({
        roomId: generateRoomId(),
        visitorName: input.visitorName,
        visitorMessage: input.visitorMessage || undefined,
        visitorTokenHash: hashToken(visitorToken),
        visitorFingerprint: input.fingerprint,
        status: 'pending',
        expiresAt,
      });
      created = doc.toObject() as MeetingDoc;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err; // vanishingly unlikely roomId collision: retry
    }
  }
  if (!created) throw new Error('Could not allocate a unique room id');

  emitToHosts('meeting:new', toHostView(created));
  // Fire-and-forget: the outbox row already exists, so a failure here is retried by the scheduler.
  void dispatchNotification(created.roomId).catch((err: unknown) =>
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'notification dispatch crashed'),
  );

  return { meeting: created, visitorToken };
}

export async function getPublicStatus(roomId: string): Promise<PublicMeetingStatus> {
  const found = await findByRoomId(roomId);
  if (!found) throw notFound('meeting_not_found', 'Meeting not found');
  return toPublicStatus(await applyTimeouts(found));
}

/** Verifies the meeting-specific visitor credential. Missing meeting and wrong token are indistinguishable. */
export async function authenticateVisitor(roomId: string, token: string): Promise<MeetingDoc> {
  const meeting = await Meeting.findOne({ roomId }).select('+visitorTokenHash').lean<MeetingDoc>();
  const valid = Boolean(meeting?.visitorTokenHash) && safeEqualHex(hashToken(token), meeting?.visitorTokenHash ?? '');
  if (!meeting || !valid) throw forbidden('invalid_visitor_credentials', 'Invalid meeting credentials');
  const { visitorTokenHash: _omit, ...rest } = meeting;
  return rest as MeetingDoc;
}

export async function cancelMeeting(roomId: string, token: string): Promise<PublicMeetingStatus> {
  const meeting = await applyTimeouts(await authenticateVisitor(roomId, token));
  const cancelled = await transition(roomId, 'cancelled', {
    set: { endedAt: new Date(), endedBy: 'visitor' satisfies EndedBy },
    reason: 'visitor_cancelled',
  });
  if (!cancelled) {
    const latest = (await findByRoomId(roomId)) ?? meeting;
    throw conflict('invalid_state', `A meeting that is ${latest.status} cannot be cancelled`);
  }
  return toPublicStatus(cancelled);
}

/* ----------------------------------------------------------------------------------------------
 * Host operations
 * -------------------------------------------------------------------------------------------- */

export async function listHostMeetings(filter: { status?: MeetingStatus; limit: number }) {
  const docs = await Meeting.find(filter.status ? { status: filter.status } : {})
    .sort({ createdAt: -1 })
    .limit(filter.limit)
    .lean<MeetingDoc[]>();
  const fresh = await Promise.all(docs.map((d) => applyTimeouts(d)));
  return fresh.map(toHostView);
}

export async function getHostMeeting(roomId: string) {
  const found = await findByRoomId(roomId);
  if (!found) throw notFound('meeting_not_found', 'Meeting not found');
  return toHostView(await applyTimeouts(found));
}

export async function acceptMeeting(roomId: string) {
  const found = await findByRoomId(roomId);
  if (!found) throw notFound('meeting_not_found', 'Meeting not found');
  const current = await applyTimeouts(found);
  if (current.status === 'expired') throw conflict('meeting_expired', 'This request has expired');
  if (current.status !== 'pending') throw conflict('invalid_state', `A meeting that is ${current.status} cannot be accepted`);

  if (!(await acquireSlot(roomId))) {
    throw conflict('host_busy', 'The maximum number of active calls has been reached');
  }

  const accepted = await transition(roomId, 'accepted', {
    set: { acceptedAt: new Date() },
    where: { expiresAt: { $gt: new Date() } },
    reason: 'host_accepted',
  });
  if (!accepted) {
    await CallSlot.deleteMany({ roomId });
    const latest = await findByRoomId(roomId);
    throw conflict('invalid_state', `A meeting that is ${latest?.status ?? 'unknown'} cannot be accepted`);
  }
  return toHostView(accepted);
}

export async function rejectMeeting(roomId: string) {
  const found = await findByRoomId(roomId);
  if (!found) throw notFound('meeting_not_found', 'Meeting not found');
  const current = await applyTimeouts(found);
  if (current.status === 'expired') throw conflict('meeting_expired', 'This request has expired');

  const rejected = await transition(roomId, 'rejected', {
    set: { endedAt: new Date(), endedBy: 'host' satisfies EndedBy },
    where: { expiresAt: { $gt: new Date() } },
    reason: 'host_rejected',
  });
  if (!rejected) {
    const latest = await findByRoomId(roomId);
    throw conflict('invalid_state', `A meeting that is ${latest?.status ?? 'unknown'} cannot be rejected`);
  }
  return toHostView(rejected);
}

/** Ends an accepted or in-progress call. `by` is derived from the authenticated caller, never from input. */
export async function endMeeting(roomId: string, by: Exclude<EndedBy, 'system'>) {
  const found = await findByRoomId(roomId);
  if (!found) throw notFound('meeting_not_found', 'Meeting not found');
  await applyTimeouts(found);

  const ended = await transition(roomId, 'ended', {
    set: { endedAt: new Date(), endedBy: by },
    reason: `${by}_ended`,
  });
  if (!ended) {
    const latest = await findByRoomId(roomId);
    throw conflict('invalid_state', `A meeting that is ${latest?.status ?? 'unknown'} cannot be ended`);
  }
  return toHostView(ended);
}

/** Rejects every currently pending request (e.g. when the host is leaving). */
export async function rejectAllPending(): Promise<number> {
  const pending = await Meeting.find({ status: 'pending' }).select('roomId').limit(500).lean<Pick<MeetingDoc, 'roomId'>[]>();
  let count = 0;
  for (const { roomId } of pending) {
    const result = await transition(roomId, 'rejected', {
      set: { endedAt: new Date(), endedBy: 'host' satisfies EndedBy },
      reason: 'host_rejected_all',
    });
    if (result) count += 1;
  }
  return count;
}

/* ----------------------------------------------------------------------------------------------
 * Connection tracking (called by the Socket.IO layer)
 * -------------------------------------------------------------------------------------------- */

export async function registerSocket(roomId: string, role: 'host' | 'visitor', socketId: string): Promise<string | undefined> {
  const field = role === 'host' ? 'hostSocketId' : 'visitorSocketId';
  const updated = await Meeting.findOneAndUpdate(
    { roomId, status: { $in: ['pending', ...ACTIVE_STATUSES] } },
    { $set: { [field]: socketId } },
    { new: false },
  )
    .select(field)
    .lean<Pick<MeetingDoc, 'hostSocketId' | 'visitorSocketId'> | null>();
  if (!updated) {
    const current = await findByRoomId(roomId);
    if (!current) throw notFound('meeting_not_found', 'Meeting not found');
    throw conflict('invalid_state', `A meeting that is ${current.status} cannot accept a participant`);
  }
  // Both sides present again: clear the "peer lost" marker.
  await Meeting.updateOne(
    { roomId, hostSocketId: { $ne: null }, visitorSocketId: { $ne: null }, peerLostAt: { $ne: null } },
    { $unset: { peerLostAt: 1 } },
  );
  return role === 'host' ? updated.hostSocketId : updated.visitorSocketId;
}

/**
 * Clears the transient socket reference only if it still points at this socket (a reconnect may already
 * have replaced it). Returns true if this socket was the registered one.
 */
export async function unregisterSocket(roomId: string, role: 'host' | 'visitor', socketId: string): Promise<boolean> {
  const field = role === 'host' ? 'hostSocketId' : 'visitorSocketId';
  const result = await Meeting.updateOne({ roomId, [field]: socketId }, { $unset: { [field]: 1 } });
  if (result.modifiedCount === 0) return false;
  await Meeting.updateOne(
    { roomId, status: { $in: ACTIVE_STATUSES as MeetingStatus[] }, peerLostAt: null },
    { $set: { peerLostAt: new Date() } },
  );
  return true;
}

/** Throws unless the meeting currently allows signaling (accepted or in_progress). */
export async function requireSignalingState(roomId: string): Promise<MeetingDoc> {
  const found = await findByRoomId(roomId);
  if (!found) throw notFound('meeting_not_found', 'Meeting not found');
  const current = await applyTimeouts(found);
  if (!ACTIVE_STATUSES.includes(current.status)) {
    throw conflict('invalid_state', `Signaling is not allowed while the meeting is ${current.status}`);
  }
  return current;
}

/**
 * Records that one side's RTCPeerConnection reached "connected". The meeting becomes in_progress, and
 * startedAt is set, only once BOTH sides have reported it. A click on a button never starts a call.
 */
export async function markConnected(roomId: string, role: 'host' | 'visitor'): Promise<MeetingDoc> {
  const env = getEnv();
  const field = role === 'host' ? 'hostConnectedAt' : 'visitorConnectedAt';
  const marked = await Meeting.updateOne(
    { roomId, status: { $in: ACTIVE_STATUSES as MeetingStatus[] } },
    { $set: { [field]: new Date() } },
  );
  if (marked.matchedCount === 0) throw conflict('invalid_state', 'The meeting is not active');

  const now = new Date();
  const started = await transition(roomId, 'in_progress', {
    set: { startedAt: now, maxEndsAt: new Date(now.getTime() + env.MEETING_DURATION_LIMIT_SECONDS * 1000) },
    unset: ['peerLostAt'],
    where: { hostConnectedAt: { $ne: null }, visitorConnectedAt: { $ne: null } },
    reason: 'both_peers_connected',
  });
  const current = started ?? (await findByRoomId(roomId));
  if (!current) throw notFound('meeting_not_found', 'Meeting not found');
  return current;
}

/* ----------------------------------------------------------------------------------------------
 * Sweeper
 * -------------------------------------------------------------------------------------------- */

export async function sweep(): Promise<number> {
  const env = getEnv();
  const now = Date.now();
  const candidates = await Meeting.find({
    $or: [
      { status: 'pending', expiresAt: { $lte: new Date(now) } },
      { status: 'accepted', acceptedAt: { $lte: new Date(now - env.ACCEPTED_START_TIMEOUT_SECONDS * 1000) } },
      { status: 'in_progress', maxEndsAt: { $lte: new Date(now) } },
      { status: 'in_progress', peerLostAt: { $lte: new Date(now - env.RECONNECT_GRACE_SECONDS * 1000) } },
    ],
  })
    .limit(200)
    .lean<MeetingDoc[]>();

  for (const meeting of candidates) {
    try {
      await applyTimeouts(meeting);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'sweep failed for a meeting');
    }
  }
  await reconcileSlots();
  return candidates.length;
}
