import { describe, expect, it } from 'vitest';
import { MEETING_STATUSES } from '../../src/models/Meeting';
import { TRANSITIONS, allowedFrom, canTransition, isTerminal } from '../../src/services/meeting.state';

describe('meeting state machine', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('pending', 'accepted')).toBe(true);
    expect(canTransition('pending', 'rejected')).toBe(true);
    expect(canTransition('pending', 'expired')).toBe(true);
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('accepted', 'in_progress')).toBe(true);
    expect(canTransition('accepted', 'expired')).toBe(true);
    expect(canTransition('accepted', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'ended')).toBe(true);
  });

  it('forbids skipping states and leaving terminal states', () => {
    expect(canTransition('pending', 'in_progress')).toBe(false);
    expect(canTransition('pending', 'ended')).toBe(false);
    expect(canTransition('in_progress', 'cancelled')).toBe(false);
    expect(canTransition('in_progress', 'accepted')).toBe(false);
    for (const terminal of ['rejected', 'ended', 'expired', 'cancelled'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      expect(TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('derives preconditions from the table', () => {
    expect(allowedFrom('accepted')).toEqual(['pending']);
    expect(allowedFrom('ended').sort()).toEqual(['accepted', 'in_progress']);
    expect(allowedFrom('pending')).toEqual([]);
    expect(MEETING_STATUSES.every((s) => s in TRANSITIONS)).toBe(true);
  });
});
