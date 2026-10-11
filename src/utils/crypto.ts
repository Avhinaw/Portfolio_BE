import { createHmac } from 'node:crypto';
import { getEnv } from '../config/env';

/** Keyed hash of the client IP, used only to cap concurrent pending requests. The raw IP is never stored. */
export function visitorFingerprint(ip: string | undefined): string {
  return createHmac('sha256', getEnv().JWT_ACCESS_SECRET)
    .update(`visitor-fingerprint:${ip ?? 'unknown'}`)
    .digest('hex');
}
