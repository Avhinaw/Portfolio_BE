import { z } from 'zod';
import { MEETING_STATUSES } from '../models/Meeting';
import { ROOM_ID_REGEX } from '../utils/roomId';
import { sanitizeText } from '../utils/sanitize';

const requiredText = (max: number) =>
  z
    .string()
    .max(max * 4, 'too long') // cheap guard before any processing
    .transform(sanitizeText)
    .pipe(z.string().min(1, 'is required').max(max, `must be at most ${max} characters`));

const optionalText = (max: number) =>
  z
    .string()
    .max(max * 4, 'too long')
    .transform(sanitizeText)
    .pipe(z.string().max(max, `must be at most ${max} characters`));

export const createMeetingBody = z
  .object({
    visitorName: requiredText(80),
    visitorMessage: optionalText(500).optional(),
  })
  .strict();

export const roomIdParams = z.object({ roomId: z.string().regex(ROOM_ID_REGEX, 'invalid room id') });

export const hostListQuery = z.object({
  status: z.enum(MEETING_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const availabilityBody = z.object({ available: z.boolean() }).strict();

export type CreateMeetingBody = z.infer<typeof createMeetingBody>;
