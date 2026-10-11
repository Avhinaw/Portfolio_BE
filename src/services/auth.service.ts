import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/env';
import { HostSession } from '../models/HostSession';
import { generateSessionId, safeStringEqual } from '../utils/roomId';
import { unauthorized } from '../utils/errors';
import { disconnectSession } from './realtime';

const ISSUER = 'portfolio-call-backend';
const AUDIENCE = 'portfolio-host';

let dummyHash: Promise<string> | undefined;
/** Verified against when the e-mail is wrong so that response time does not reveal whether it matched. */
const getDummyHash = (): Promise<string> => {
  if (!dummyHash) dummyHash = argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });
  return dummyHash;
};

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: Date;
}

export async function login(email: string, password: string, userAgent?: string): Promise<LoginResult> {
  const env = getEnv();
  const emailMatches = safeStringEqual(email.trim().toLowerCase(), env.HOST_EMAIL.trim().toLowerCase());
  const hash = emailMatches ? env.HOST_PASSWORD_HASH : await getDummyHash();

  let passwordMatches = false;
  try {
    passwordMatches = await argon2.verify(hash, password);
  } catch {
    passwordMatches = false;
  }
  if (!emailMatches || !passwordMatches) {
    throw unauthorized('invalid_credentials', 'Invalid email or password');
  }

  const sid = generateSessionId();
  const expiresAt = new Date(Date.now() + env.JWT_ACCESS_TTL * 1000);
  await HostSession.create({ sid, expiresAt, userAgent: userAgent?.slice(0, 300) });

  const accessToken = jwt.sign({ sid }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: 'host',
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.JWT_ACCESS_TTL,
  });
  return { accessToken, tokenType: 'Bearer', expiresAt };
}

export interface VerifiedHost {
  sid: string;
  exp: number;
}

/** Verifies signature, claims, expiry AND that the server-side session has not been revoked (logout). */
export async function verifyAccessToken(token: string): Promise<VerifiedHost> {
  const env = getEnv();
  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'host',
    });
    if (typeof decoded === 'string') throw new Error('unexpected payload');
    payload = decoded;
  } catch {
    throw unauthorized('invalid_token', 'Invalid or expired access token');
  }

  const sid = typeof payload.sid === 'string' ? payload.sid : '';
  if (!sid || typeof payload.exp !== 'number') throw unauthorized('invalid_token', 'Invalid or expired access token');

  const session = await HostSession.findOne({ sid, revokedAt: null, expiresAt: { $gt: new Date() } })
    .select('sid')
    .lean();
  if (!session) throw unauthorized('session_revoked', 'Session is no longer valid');
  return { sid, exp: payload.exp };
}

export async function logout(sid: string): Promise<void> {
  await HostSession.updateOne({ sid, revokedAt: null }, { $set: { revokedAt: new Date() } });
  // Drop any live dashboard sockets that were authenticated with this session.
  disconnectSession(sid);
}
