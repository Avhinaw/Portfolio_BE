import { createHmac } from 'node:crypto';
import type { Env } from '../config/env';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Builds the RTCConfiguration.iceServers array for the browser.
 * With TURN_SHARED_SECRET, credentials follow the "TURN REST API" convention understood by coturn
 * (`use-auth-secret`): username = "<expiryUnix>:<label>", credential = base64(HMAC-SHA1(secret, username)).
 */
export function buildIceServers(env: Env, label: string, now: number = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  if (env.STUN_URLS.length > 0) servers.push({ urls: env.STUN_URLS });

  if (env.TURN_URL.length > 0) {
    if (env.TURN_SHARED_SECRET) {
      const expiry = Math.floor(now / 1000) + env.TURN_CREDENTIAL_TTL_SECONDS;
      const username = `${expiry}:${label}`;
      const credential = createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64');
      servers.push({ urls: env.TURN_URL, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_PASSWORD) {
      servers.push({ urls: env.TURN_URL, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD });
    }
  }
  return servers;
}
