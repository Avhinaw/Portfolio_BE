import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestServer, startTestServer } from '../helpers/server';
import { restoreFetch as restoreFetchMocks } from '../helpers/telegram';

let server: TestServer;
let providerRequest: { url: string; body: Record<string, unknown> } | undefined;

beforeAll(async () => {
  server = await startTestServer({ GEMINI_API_KEY: 'test-gemini-key' });
});

afterAll(async () => {
  await server.stop();
});

afterEach(() => {
  providerRequest = undefined;
  restoreFetchMocks();
});

function mockGemini(status: number, result: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) {
      throw new Error('Unexpected external request in hire-bot test');
    }
    providerRequest = {
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('POST /api/hire-bot/chat', () => {
  it('answers with the selected mode and bounded conversation history', async () => {
    mockGemini(200, {
      candidates: [{ content: { parts: [{ text: 'A serious, profile-grounded answer.' }] } }],
    });

    const response = await request(server.app).post('/api/hire-bot/chat').send({
      message: 'What are their skills?',
      mode: 'serious',
      history: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi!' }],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, data: { reply: 'A serious, profile-grounded answer.' } });
    expect(providerRequest?.url).toContain('key=test-gemini-key');
    expect(JSON.stringify(providerRequest?.body)).toContain('serious mode');
    expect(providerRequest?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi!' }] },
      { role: 'user', parts: [{ text: 'What are their skills?' }] },
    ]);
  });

  it('validates modes and request properties before calling Gemini', async () => {
    const response = await request(server.app)
      .post('/api/hire-bot/chat')
      .send({ message: 'Hello', mode: 'invented', unexpected: true });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(providerRequest).toBeUndefined();
  });

  it('surfaces provider failures without exposing provider response content', async () => {
    mockGemini(403, { error: { message: 'private provider details' } });

    const response = await request(server.app).post('/api/hire-bot/chat').send({ message: 'Hello', mode: 'fun' });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('hire_bot_provider_error');
    expect(response.body.error.message).not.toContain('private provider details');
    expect(JSON.stringify(providerRequest?.body)).toContain('fun mode');
  });
});
