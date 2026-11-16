export interface AvailabilityWindow {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface AvailabilitySchedule {
  enabled: boolean;
  timezone: string;
  windows: AvailabilityWindow[];
}

export const DEFAULT_AVAILABILITY_SCHEDULE: AvailabilitySchedule = {
  enabled: false,
  timezone: 'UTC',
  windows: [],
};

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeSchedule(input?: Partial<AvailabilitySchedule> | null): AvailabilitySchedule {
  return {
    enabled: input?.enabled ?? DEFAULT_AVAILABILITY_SCHEDULE.enabled,
    timezone: input?.timezone || DEFAULT_AVAILABILITY_SCHEDULE.timezone,
    windows: input?.windows ? [...input.windows] : [],
  };
}

function localDateParts(date: Date, timezone: string): { dayOfWeek: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday ?? '');
  if (dayOfWeek < 0 || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error('Could not determine local availability time');
  }
  return { dayOfWeek, minute: hour * 60 + minute };
}

export function isWithinUnavailableSchedule(schedule: AvailabilitySchedule, date = new Date()): boolean {
  if (!schedule.enabled || schedule.windows.length === 0) return false;
  const local = localDateParts(date, schedule.timezone);
  return schedule.windows.some(
    (window) => window.dayOfWeek === local.dayOfWeek && local.minute >= window.startMinute && local.minute < window.endMinute,
  );
}
