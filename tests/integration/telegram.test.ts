import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Meeting } from '../../src/models/Meeting';
import { generateRoomId } from '../../src/utils/roomId';
import { dispatchNotification, processDueNotifications } from '../../src/services/notification.service';
import { TELEGRAM_TOKEN, bearer, createMeeting, loginHost, startTestServer, waitFor, type TestServer } from '../helpers/server';
import { mockTelegram, restoreFetch, telegramError, telegramOk } from '../helpers/telegram';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ NOTIFY_MAX_ATTEMPTS: '3', NOTIFY_RETRY_BASE_SECONDS: '1' });
});
afterAll(async () => {
  await server.stop();
});
afterEach(() => restoreFetch());

const notification = async (roomId: string) => (await Meeting.findOne({ roomId }).lean())!.notification;

describe('Telegram failure handling', () => {
  it('keeps the meeting pending and consistent when Telegram returns 5xx, then retries until delivered', async () => {
    let calls = 0;
    mockTelegram(() => (++calls === 1 ? telegramError(502, 'Bad Gateway') : telegramOk(5)));
    const m = await createMeeting(server.app, 'Retry');

    const afterFirst = await waitFor(async () => {
      const n = await notification(m.roomId);
      return n.attempts >= 1 && n.lastError ? n : undefined;
    });
    expect(afterFirst.status).toBe('pending'); // NOT claimed as delivered
    expect(afterFirst.sentAt).toBeUndefined();
    expect((await Meeting.findOne({ roomId: m.roomId }).lean())?.status).toBe('pending');
    expect((await request(server.app).get(`/api/meetings/${m.roomId}/status`)).status).toBe(200);

    // Make the retry due and run the worker.
    await Meeting.updateOne({ roomId: m.roomId }, { $set: { 'notification.nextAttemptAt': new Date(Date.now() - 1) } });
    await processDueNotifications();
    const done = await notification(m.roomId);
    expect(done.status).toBe('sent');
    expect(calls).toBe(2);
  });

  it('marks permanent errors (e.g. 401 invalid token) as failed without retrying, and does not leak the token', async () => {
    const mock = mockTelegram(() => telegramError(401, `Unauthorized ${TELEGRAM_TOKEN}`));
    const m = await createMeeting(server.app, 'Permanent');
    const n = await waitFor(async () => {
      const x = await notification(m.roomId);
      return x.status === 'failed' ? x : undefined;
    });
    expect(n.lastError).toContain('401');
    expect(n.lastError).not.toContain(TELEGRAM_TOKEN);
    expect(mock.mock.calls.filter(([, init]) => String((init as RequestInit).body).includes('Permanent'))).toHaveLength(1);
  });

  it('treats network errors/timeouts as retryable and stops after NOTIFY_MAX_ATTEMPTS', async () => {
    mockTelegram(() => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
    });
    const m = await createMeeting(server.app, 'Flaky');
    // Attempt 1 is the fire-and-forget dispatch from creation; wait until it has finished.
    await waitFor(async () => {
      const n = await notification(m.roomId);
      return n.attempts === 1 && n.lastError ? n : undefined;
    });
    // Attempts 2 and 3 are driven explicitly (the worker awaits each dispatch).
    for (let i = 0; i < 2; i += 1) {
      await Meeting.updateOne({ roomId: m.roomId }, { $set: { 'notification.nextAttemptAt': new Date(Date.now() - 1) } });
      await processDueNotifications();
    }
    const n = await notification(m.roomId);
    expect(n.status).toBe('failed');
    expect(n.attempts).toBe(3);
    expect(n.lastError).not.toContain(TELEGRAM_TOKEN);
  });

  it('does not send duplicate alerts when dispatch runs concurrently', async () => {
    const mock = mockTelegram(() => telegramOk());
    const m = await createMeeting(server.app, 'Dedupe');
    await Promise.all([dispatchNotification(m.roomId), dispatchNotification(m.roomId), dispatchNotification(m.roomId)]);
    await waitFor(async () => (await notification(m.roomId)).status === 'sent');
    const sends = mock.mock.calls.filter(([, init]) => String((init as RequestInit).body).includes('Dedupe'));
    expect(sends).toHaveLength(1);
  });

  it('skips the alert if the meeting is no longer pending', async () => {
    const mock = mockTelegram(() => telegramError(500, 'down'));
    // Inserted directly (no creation-time dispatch) so the test is deterministic.
    await Meeting.create({
      roomId: generateRoomId(),
      visitorName: 'Gone',
      visitorTokenHash: 'a'.repeat(64),
      status: 'cancelled',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const doc = await Meeting.findOne({ visitorName: 'Gone' }).lean();
    await dispatchNotification(doc!.roomId);
    expect((await notification(doc!.roomId)).status).toBe('skipped');
    expect(mock.mock.calls.filter(([, init]) => String((init as RequestInit).body).includes('Gone'))).toHaveLength(0);
  });
});

describe('POST /api/host/telegram/test', () => {
  it('requires authentication, reports success only when Telegram accepts the message', async () => {
    expect((await request(server.app).post('/api/host/telegram/test')).status).toBe(401);
    const token = await loginHost(server.app);

    mockTelegram(() => telegramOk());
    const ok = await request(server.app).post('/api/host/telegram/test').set(bearer(token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.delivered).toBe(true);

    mockTelegram(() => telegramError(400, 'Bad Request: chat not found'));
    const bad = await request(server.app).post('/api/host/telegram/test').set(bearer(token));
    expect(bad.status).toBe(502);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error.code).toBe('telegram_error');
    expect(JSON.stringify(bad.body)).not.toContain(TELEGRAM_TOKEN);
  });
});
