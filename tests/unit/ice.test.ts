import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { buildIceServers } from '../../src/services/ice.service';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/x',
  FRONTEND_ORIGINS: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  HOST_EMAIL: 'me@example.com',
  HOST_PASSWORD_HASH: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
};

describe('buildIceServers', () => {
  it('returns an empty list when nothing is configured', () => {
    expect(buildIceServers(loadEnv(base), 'room')).toEqual([]);
  });

  it('adds STUN and static TURN credentials', () => {
    const env = loadEnv({
      ...base,
      STUN_URLS: 'stun:turn.example.com:3478',
      TURN_URL: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp',
      TURN_USERNAME: 'u',
      TURN_PASSWORD: 'p',
    });
    expect(buildIceServers(env, 'room')).toEqual([
      { urls: ['stun:turn.example.com:3478'] },
      {
        urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
        username: 'u',
        credential: 'p',
      },
    ]);
  });

  it('generates time-limited TURN REST credentials (coturn use-auth-secret)', () => {
    const secret = 's'.repeat(32);
    const env = loadEnv({ ...base, TURN_URL: 'turn:turn.example.com:3478', TURN_SHARED_SECRET: secret, TURN_CREDENTIAL_TTL_SECONDS: '600' });
    const now = 1_700_000_000_000;
    const [server] = buildIceServers(env, 'abc', now);
    expect(server?.username).toBe(`${1_700_000_000 + 600}:abc`);
    expect(server?.credential).toBe(createHmac('sha1', secret).update(server!.username!).digest('base64'));
  });
});
