import { MEETING_STATUSES, type MeetingStatus } from '../models/Meeting';

/**
 * Meeting lifecycle (single source of truth).
 *
 *   pending ──accept──▶ accepted ──both peers connected──▶ in_progress ──end/limit/peer lost──▶ ended
 *      │                   │  └──host/visitor ends before connect──▶ ended
 *      │                   ├──never started in time──▶ expired
 *      │                   └──visitor cancels──▶ cancelled
 *      ├──reject──▶ rejected
 *      ├──ttl──▶ expired
 *      └──visitor cancels──▶ cancelled
 */
export const TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  pending: ['accepted', 'rejected', 'expired', 'cancelled'],
  accepted: ['in_progress', 'ended', 'expired', 'cancelled'],
  in_progress: ['ended'],
  rejected: [],
  ended: [],
  expired: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly MeetingStatus[] = ['rejected', 'ended', 'expired', 'cancelled'];
export const ACTIVE_STATUSES: readonly MeetingStatus[] = ['accepted', 'in_progress'];

export const canTransition = (from: MeetingStatus, to: MeetingStatus): boolean => TRANSITIONS[from].includes(to);
export const isTerminal = (status: MeetingStatus): boolean => TERMINAL_STATUSES.includes(status);

/** Statuses from which `to` may be entered. Used as the atomic precondition of every update. */
export const allowedFrom = (to: MeetingStatus): MeetingStatus[] =>
  MEETING_STATUSES.filter((from) => TRANSITIONS[from].includes(to));
