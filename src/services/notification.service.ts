import { getEnv } from '../config/env';
import { Meeting, type MeetingDoc } from '../models/Meeting';
import { logger } from '../utils/logger';
import {
  TelegramError,
  formatIncomingCallMessage,
  isTelegramConfigured,
  sendTelegramMessage,
} from './telegram.service';

const LOCK_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Notification outbox. The outbox state lives inside the Meeting document, so a meeting and its pending
 * notification are created atomically. Delivery is at-least-once with a lease (lockedUntil) so concurrent
 * workers/instances do not send the same alert twice. The only duplicate window is a crash between a
 * successful Telegram call and the follow-up database write; the lease then expires and one retry occurs.
 */
async function claim(roomId: string): Promise<MeetingDoc | null> {
  const now = new Date();
  return Meeting.findOneAndUpdate(
    {
      roomId,
      'notification.status': 'pending',
      'notification.nextAttemptAt': { $lte: now },
      $or: [{ 'notification.lockedUntil': null }, { 'notification.lockedUntil': { $lte: now } }],
    },
    {
      $set: { 'notification.lockedUntil': new Date(now.getTime() + LOCK_MS) },
      $inc: { 'notification.attempts': 1 },
    },
    { new: true },
  ).lean<MeetingDoc>();
}

export async function dispatchNotification(roomId: string): Promise<void> {
  const env = getEnv();
  const meeting = await claim(roomId);
  if (!meeting) return;

  const finish = (set: Record<string, unknown>) =>
    Meeting.updateOne({ roomId }, { $set: set, $unset: { 'notification.lockedUntil': 1 } });

  if (meeting.status !== 'pending') {
    await finish({ 'notification.status': 'skipped', 'notification.lastError': 'meeting_no_longer_pending' });
    return;
  }
  if (!isTelegramConfigured()) {
    await finish({ 'notification.status': 'skipped', 'notification.lastError': 'telegram_not_configured' });
    logger.warn({ roomId }, 'Telegram not configured; notification skipped');
    return;
  }

  try {
    const { messageId } = await sendTelegramMessage(formatIncomingCallMessage(meeting));
    await finish({
      'notification.status': 'sent',
      'notification.sentAt': new Date(),
      'notification.telegramMessageId': messageId,
    });
    logger.info({ roomId }, 'Telegram notification sent');
  } catch (err) {
    const message = err instanceof TelegramError ? err.message : 'unexpected notification error';
    const retryable = err instanceof TelegramError ? err.retryable : false;
    const attempts = meeting.notification.attempts;

    if (!retryable || attempts >= env.NOTIFY_MAX_ATTEMPTS) {
      await finish({ 'notification.status': 'failed', 'notification.lastError': message.slice(0, 500) });
      logger.error({ roomId, attempts, reason: message }, 'Telegram notification failed permanently');
      return;
    }

    const backoff = Math.min(env.NOTIFY_RETRY_BASE_SECONDS * 1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    const retryAfter = err instanceof TelegramError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
    await finish({
      'notification.lastError': message.slice(0, 500),
      'notification.nextAttemptAt': new Date(Date.now() + Math.max(backoff, retryAfter)),
    });
    logger.warn({ roomId, attempts, reason: message }, 'Telegram notification failed; will retry');
  }
}

/** Processes notifications that are due (called by the scheduler and by tests). */
export async function processDueNotifications(limit = 10): Promise<number> {
  const due = await Meeting.find({
    'notification.status': 'pending',
    'notification.nextAttemptAt': { $lte: new Date() },
  })
    .sort({ 'notification.nextAttemptAt': 1 })
    .limit(limit)
    .select('roomId')
    .lean<Pick<MeetingDoc, 'roomId'>[]>();

  for (const { roomId } of due) {
    await dispatchNotification(roomId);
  }
  return due.length;
}
