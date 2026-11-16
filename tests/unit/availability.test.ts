import { describe, expect, it } from 'vitest';
import { isWithinUnavailableSchedule, type AvailabilitySchedule } from '../../src/utils/availability';

const schedule: AvailabilitySchedule = {
  enabled: true,
  timezone: 'UTC',
  windows: [{ dayOfWeek: 1, startMinute: 60, endMinute: 480 }],
};

describe('recurring availability schedule', () => {
  it('blocks inside the configured weekday window in the configured timezone', () => {
    expect(isWithinUnavailableSchedule(schedule, new Date('2026-11-16T03:00:00.000Z'))).toBe(true);
    expect(isWithinUnavailableSchedule(schedule, new Date('2026-11-16T08:00:00.000Z'))).toBe(false);
  });

  it('uses the selected timezone when determining the local weekday and time', () => {
    const indiaSchedule = { ...schedule, timezone: 'Asia/Kolkata' };
    expect(isWithinUnavailableSchedule(indiaSchedule, new Date('2026-11-15T21:00:00.000Z'))).toBe(true);
  });

  it('does not block when disabled or on another day', () => {
    expect(isWithinUnavailableSchedule({ ...schedule, enabled: false }, new Date('2026-11-16T03:00:00.000Z'))).toBe(false);
    expect(isWithinUnavailableSchedule(schedule, new Date('2026-11-17T03:00:00.000Z'))).toBe(false);
  });
});
