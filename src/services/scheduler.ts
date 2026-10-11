import { getEnv } from '../config/env';
import { logger } from '../utils/logger';
import { processDueNotifications } from './notification.service';
import { sweep } from './meeting.service';

const timers: NodeJS.Timeout[] = [];

function every(name: string, ms: number, job: () => Promise<unknown>): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap runs of the same job
    running = true;
    job()
      .catch((err: unknown) => logger.error({ job: name, err: err instanceof Error ? err.message : 'unknown' }, 'background job failed'))
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref();
  timers.push(timer);
}

/**
 * Safe to run in every instance: both jobs use atomic conditional updates, so duplicated work is harmless.
 */
export function startBackgroundJobs(): void {
  const env = getEnv();
  every('notifications', env.NOTIFY_POLL_INTERVAL_MS, () => processDueNotifications());
  every('sweep', env.SWEEP_INTERVAL_MS, () => sweep());
}

export function stopBackgroundJobs(): void {
  while (timers.length > 0) {
    const timer = timers.pop();
    if (timer) clearInterval(timer);
  }
}
