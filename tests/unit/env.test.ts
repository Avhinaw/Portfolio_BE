import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/x',
  FRONTEND_ORIGINS: 'http://localhost:5173, https://me.dev/some/path',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  HOST_EMAIL: 'me@example.com',
  HOST_PASSWORD_HASH: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
};

describe('environment validation', () => {
  it('parses defaults and normalises origins', () => {
    const env = loadEnv({ ...base, PORT: '' });
    expect(env.PORT).toBe(3000);
    expect(env.FRONTEND_ORIGINS).toEqual(['http://localhost:5173', 'https://me.dev']);
    expect(env.JWT_ACCESS_TTL).toBe(4 * 3600);
    expect(env.MAX_ACTIVE_CALLS).toBe(1);
    expect(env.HOST_DEFAULT_AVAILABLE).toBe(true);
    expect(env.TURN_URL).toEqual([]);
  });

  it('fails fast with readable messages that do not echo secret values', () => {
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short-secret-value' })).toThrowError(/JWT_ACCESS_SECRET/);
    try {
      loadEnv({ ...base, JWT_ACCESS_SECRET: 'short-secret-value' });
    } catch (err) {
      expect((err as Error).message).not.toContain('short-secret-value');
    }
    expect(() => loadEnv({ ...base, HOST_PASSWORD_HASH: 'plaintext' })).toThrowError(/HOST_PASSWORD_HASH/);
    expect(() => loadEnv({ ...base, MONGODB_URI: '' })).toThrowError(/MONGODB_URI/);
    expect(() => loadEnv({ ...base, JWT_ACCESS_TTL: '99d' })).toThrowError(/JWT_ACCESS_TTL/);
  });

  it('requires Telegram settings to come as a pair', () => {
    expect(() => loadEnv({ ...base, TELEGRAM_BOT_TOKEN: '1'.repeat(30) })).toThrowError(/TELEGRAM/);
  });

  it('requires TURN credentials when a TURN URL is set', () => {
    expect(() => loadEnv({ ...base, TURN_URL: 'turn:turn.example.com:3478' })).toThrowError(/TURN/);
    expect(() =>
      loadEnv({ ...base, TURN_URL: 'turn:turn.example.com:3478', TURN_SHARED_SECRET: 's'.repeat(24) }),
    ).not.toThrow();
  });

  it('enforces https origins and non-placeholder secrets in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrowError(/https/);
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', FRONTEND_ORIGINS: 'https://me.dev', JWT_ACCESS_SECRET: 'change-me'.repeat(5) }),
    ).toThrowError(/placeholder/);
  });
});
