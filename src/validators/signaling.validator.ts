import { z } from 'zod';
import { ROOM_ID_REGEX } from '../utils/roomId';

/** Hard cap for SDP bodies. Real offers/answers with audio+video are typically 2-8 KB. */
export const MAX_SDP_LENGTH = 20_000;

const roomId = z.string().regex(ROOM_ID_REGEX, 'invalid room id');

const sdp = (type: 'offer' | 'answer') =>
  z
    .object({
      type: z.literal(type),
      sdp: z.string().min(1).max(MAX_SDP_LENGTH).startsWith('v=0', 'not an SDP document'),
    })
    .strict();

/** Mirrors RTCIceCandidateInit as produced by RTCIceCandidate.toJSON(). */
const iceCandidate = z
  .object({
    candidate: z.string().max(2000), // empty string = end-of-candidates marker
    sdpMid: z.string().max(100).nullish(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullish(),
    usernameFragment: z.string().max(256).nullish(),
  })
  .strict();

export const handshakeSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('host'), token: z.string().min(10).max(4096) }),
  z.object({ role: z.literal('visitor'), roomId, visitorToken: z.string().min(20).max(128) }),
]);

export const emptyPayload = z.object({}).strict();
export const hostJoinRoomPayload = z.object({ roomId }).strict();
export const meetingJoinPayload = z.object({ roomId: roomId.optional() }).strict();
export const roomPayload = z.object({ roomId }).strict();
export const offerPayload = z.object({ roomId, sdp: sdp('offer') }).strict();
export const answerPayload = z.object({ roomId, sdp: sdp('answer') }).strict();
export const icePayload = z.object({ roomId, candidate: iceCandidate }).strict();
export const connectionFailedPayload = z
  .object({ roomId, reason: z.enum(['ice_failed', 'media_error', 'timeout', 'other']) })
  .strict();
