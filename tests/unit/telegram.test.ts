import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { TelegramError, formatIncomingCallMessage, sendTelegramMessage } from '../../src/services/telegram.service';
import { mockTelegram, restoreFetch, telegramError, telegramOk } from '../helpers/telegram';

const TOKEN = '987654321:AAFakeTokenForUnitTests_abcdefghijk';

beforeAll(() => {
  loadEnv({
    MONGODB_URI: 'mongodb://localhost:27017/x',
    FRONTEND_ORIGINS: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    HOST_EMAIL: 'me@example.com',
    HOST_PASSWORD_HASH: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: '1',
    HOST_DASHBOARD_URL: 'https://host.example.com/dashboard',
    TELEGRAM_TIMEOUT_MS: '1000',
  });
});
afterEach(() => restoreFetch());

describe('formatIncomingCallMessage', () => {
  it('includes visitor, message, request time and the dashboard link but no secrets', () => {
    const text = formatIncomingCallMessage({
      visitorName: 'John',
      visitorMessage: 'I would like to discuss a project.',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      expiresAt: new Date('2026-01-02T03:09:05.000Z'),
    });
    expect(text).toContain('Incoming portfolio video call');
    expect(text).toContain('Visitor: John');
    expect(text).toContain('Message: I would like to discuss a project.');
    expect(text).toContain('Status: Waiting for your response');
    expect(text).toContain('2026-01-02T03:04:05.000Z');
    expect(text).toContain('https://host.example.com/dashboard');
    expect(text).not.toContain(TOKEN);
  });

  it('shows (none) when there is no message', () => {
    const text = formatIncomingCallMessage({
      visitorName: 'A',
      createdAt: new Date(),
      expiresAt: new Date(),
    });
    expect(text).toContain('Message: (none)');
  });
});

describe('sendTelegramMessage', () => {
  it('posts plain text (no parse_mode) to the Bot API and returns the message id', async () => {
    const mock = mockTelegram(() => telegramOk(321));
    const result = await sendTelegramMessage('<b>hi</b>');
    expect(result.messageId).toBe(321);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toBe('<b>hi</b>');
  });

  it('classifies errors: 429/5xx are retryable (honouring retry_after), 4xx are permanent', async () => {
    mockTelegram(() => telegramError(429, 'Too Many Requests: retry after 7', 7));
    await expect(sendTelegramMessage('x')).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 7 });

    mockTelegram(() => telegramError(503, 'unavailable'));
    await expect(sendTelegramMessage('x')).rejects.toMatchObject({ retryable: true });

    mockTelegram(() => telegramError(403, 'Forbidden: bot was blocked by the user'));
    await expect(sendTelegramMessage('x')).rejects.toMatchObject({ retryable: false });
  });

  it('treats an HTTP 200 with ok=false as a failure (never claims delivery)', async () => {
    mockTelegram(() => new Response(JSON.stringify({ ok: false, description: 'nope' }), { status: 200 }));
    await expect(sendTelegramMessage('x')).rejects.toBeInstanceOf(TelegramError);
  });

  it('wraps network errors without leaking the token', async () => {
    mockTelegram(() => {
      throw new TypeError(`getaddrinfo failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const err = (await sendTelegramMessage('x').catch((e: unknown) => e)) as TelegramError;
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(TOKEN);
  });
});
