import { vi, type Mock } from 'vitest';

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

export const telegramOk = (messageId = 7): Response =>
  new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });

export const telegramError = (status: number, description: string, retryAfter?: number): Response =>
  new Response(
    JSON.stringify({ ok: false, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) }),
    { status },
  );

/**
 * Replaces global fetch ONLY for api.telegram.org. Every other URL still uses the real fetch, so no real
 * Telegram message can ever be sent from tests.
 */
export function mockTelegram(responder: Responder): Mock {
  const realFetch = globalThis.fetch;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.telegram.org/')) return responder(url, init);
    return realFetch(input, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Default guard: any api.telegram.org call that a test did not explicitly mock fails instead of going out. */
export function blockTelegram(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://api.telegram.org/')) {
      return Promise.reject(new TypeError('Telegram is blocked in tests unless explicitly mocked'));
    }
    return realFetch(input, init);
  });
}

/** Removes explicit mocks and re-installs the default Telegram guard. */
export function restoreFetch(): void {
  vi.unstubAllGlobals();
  blockTelegram();
}
