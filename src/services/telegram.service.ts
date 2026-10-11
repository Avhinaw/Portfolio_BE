import { getEnv } from '../config/env';
import type { MeetingDoc } from '../models/Meeting';

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  result?: { message_id?: number };
  parameters?: { retry_after?: number };
}

export function isTelegramConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

function redact(text: string): string {
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  return token ? text.split(token).join('[REDACTED]') : text;
}

/** Sends a plain-text message (no parse_mode, so visitor text cannot inject markup). */
export async function sendTelegramMessage(text: string): Promise<{ messageId: number }> {
  const env = getEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new TelegramError('Telegram is not configured', false);
  }

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(env.TELEGRAM_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout. The error text is never forwarded (it may contain the request URL).
    const name = err instanceof Error ? err.name : 'Error';
    throw new TelegramError(`Telegram request failed (${name})`, true);
  }

  let payload: TelegramResponse | undefined;
  try {
    payload = (await response.json()) as TelegramResponse;
  } catch {
    payload = undefined;
  }

  if (response.ok && payload?.ok === true) {
    return { messageId: payload.result?.message_id ?? 0 };
  }

  const description = typeof payload?.description === 'string' ? payload.description : `HTTP ${response.status}`;
  const retryable = response.status === 429 || response.status >= 500;
  throw new TelegramError(
    redact(`Telegram API error ${response.status}: ${description}`).slice(0, 300),
    retryable,
    payload?.parameters?.retry_after,
  );
}

export function formatIncomingCallMessage(meeting: Pick<MeetingDoc, 'visitorName' | 'visitorMessage' | 'createdAt' | 'expiresAt'>): string {
  const env = getEnv();
  const lines = [
    'Incoming portfolio video call',
    '',
    `Visitor: ${meeting.visitorName}`,
    `Message: ${meeting.visitorMessage ? meeting.visitorMessage : '(none)'}`,
    'Status: Waiting for your response',
    `Requested at: ${meeting.createdAt.toISOString()}`,
    `Request expires at: ${meeting.expiresAt.toISOString()}`,
    '',
    'Open your private host dashboard to accept or reject.',
  ];
  // The dashboard link is a plain URL: it carries no token and still requires host login.
  if (env.HOST_DASHBOARD_URL) lines.push(`Dashboard: ${env.HOST_DASHBOARD_URL}`);
  return lines.join('\n');
}
