import { Schema, model, type Types } from 'mongoose';
import { ROOM_ID_REGEX } from '../utils/roomId';

export const MEETING_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'in_progress',
  'ended',
  'expired',
  'cancelled',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const ENDED_BY = ['host', 'visitor', 'system'] as const;
export type EndedBy = (typeof ENDED_BY)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface MeetingDoc {
  _id: Types.ObjectId;
  roomId: string;
  visitorName: string;
  visitorMessage?: string;
  /** SHA-256 of the meeting-specific visitor credential. Never selected by default. */
  visitorTokenHash?: string;
  /** HMAC of the client IP (not the IP itself), used to cap concurrent pending requests. */
  visitorFingerprint?: string;
  status: MeetingStatus;
  expiresAt: Date;
  acceptedAt?: Date;
  startedAt?: Date;
  endedAt?: Date;
  endedBy?: EndedBy;
  /** Set when each side reports RTCPeerConnection.connectionState === "connected". */
  hostConnectedAt?: Date;
  visitorConnectedAt?: Date;
  /** startedAt + MEETING_DURATION_LIMIT_SECONDS */
  maxEndsAt?: Date;
  /** Set when a participant socket disconnects during accepted/in_progress; cleared when both are back. */
  peerLostAt?: Date;
  /** Transient connection references. NOT identity or authorization. */
  visitorSocketId?: string;
  hostSocketId?: string;
  /** Set on terminal states; a TTL index deletes the document after MEETING_RETENTION_DAYS. */
  purgeAt?: Date;
  /** Notification outbox, stored in the same document so creation is atomic with the meeting. */
  notification: {
    status: NotificationStatus;
    attempts: number;
    nextAttemptAt: Date;
    lockedUntil?: Date | null;
    sentAt?: Date;
    lastError?: string;
    telegramMessageId?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const meetingSchema = new Schema<MeetingDoc>(
  {
    roomId: { type: String, required: true, immutable: true, match: ROOM_ID_REGEX },
    visitorName: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    visitorMessage: { type: String, trim: true, maxlength: 500 },
    visitorTokenHash: { type: String, select: false },
    visitorFingerprint: { type: String, select: false },
    status: { type: String, enum: MEETING_STATUSES, required: true, default: 'pending' },
    expiresAt: { type: Date, required: true },
    acceptedAt: Date,
    startedAt: Date,
    endedAt: Date,
    endedBy: { type: String, enum: ENDED_BY },
    hostConnectedAt: Date,
    visitorConnectedAt: Date,
    maxEndsAt: Date,
    peerLostAt: Date,
    visitorSocketId: String,
    hostSocketId: String,
    purgeAt: Date,
    notification: {
      status: { type: String, enum: NOTIFICATION_STATUSES, default: 'pending' },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: () => new Date() },
      lockedUntil: { type: Date },
      sentAt: Date,
      lastError: { type: String, maxlength: 500 },
      telegramMessageId: Number,
    },
  },
  { timestamps: true, versionKey: false },
);

// Lookup by public room id.
meetingSchema.index({ roomId: 1 }, { unique: true });
// Pending queue and "recent meetings" listings.
meetingSchema.index({ status: 1, createdAt: -1 });
meetingSchema.index({ createdAt: -1 });
// Expiration sweeper.
meetingSchema.index({ status: 1, expiresAt: 1 });
meetingSchema.index({ status: 1, acceptedAt: 1 });
meetingSchema.index({ status: 1, maxEndsAt: 1 });
meetingSchema.index({ status: 1, peerLostAt: 1 });
// Duplicate-pending protection.
meetingSchema.index({ visitorFingerprint: 1, status: 1 });
// Notification outbox polling.
meetingSchema.index({ 'notification.status': 1, 'notification.nextAttemptAt': 1 });
// TTL: only terminal meetings get a purgeAt, so pending/active meetings are never deleted by MongoDB.
meetingSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const Meeting = model<MeetingDoc>('Meeting', meetingSchema);
