import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 24 random bytes -> 32 base64url characters (192 bits of entropy). */
export const ROOM_ID_REGEX = /^[A-Za-z0-9_-]{32}$/;

export const generateRoomId = (): string => randomBytes(24).toString('base64url');

/** Meeting-specific visitor credential (256 bits). Only its SHA-256 hash is stored. */
export const generateVisitorToken = (): string => randomBytes(32).toString('base64url');

export const generateSessionId = (): string => randomBytes(24).toString('base64url');

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/** Constant-time string comparison that does not leak length (compares digests). */
export function safeStringEqual(a: string, b: string): boolean {
  return safeEqualHex(hashToken(a), hashToken(b));
}
