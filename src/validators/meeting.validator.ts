import { z } from 'zod';
import { MEETING_STATUSES } from '../models/Meeting';
import { ROOM_ID_REGEX } from '../utils/roomId';
import { sanitizeText } from '../utils/sanitize';
import { isValidTimeZone } from '../utils/availability';

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

const availabilityWindow = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((window) => window.startMinute < window.endMinute, {
    message: 'endMinute must be after startMinute',
  });

export const availabilityScheduleBody = z
  .object({
    enabled: z.boolean(),
    timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, 'must be a valid IANA timezone'),
    windows: z.array(availabilityWindow).max(7),
  })
  .strict()
  .superRefine((schedule, ctx) => {
    const byDay = new Map<number, Array<{ startMinute: number; endMinute: number; index: number }>>();
    schedule.windows.forEach((window, index) => {
      const windows = byDay.get(window.dayOfWeek) ?? [];
      windows.push({ ...window, index });
      byDay.set(window.dayOfWeek, windows);
    });
    for (const windows of byDay.values()) {
      windows.sort((a, b) => a.startMinute - b.startMinute);
      for (let index = 1; index < windows.length; index += 1) {
        if (windows[index].startMinute < windows[index - 1].endMinute) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['windows', windows[index].index], message: 'windows cannot overlap on the same day' });
        }
      }
    }
  });

export type CreateMeetingBody = z.infer<typeof createMeetingBody>;
