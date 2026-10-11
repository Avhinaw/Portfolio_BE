import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../services/auth.service';
import { unauthorized } from '../utils/errors';

export function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S{10,4096})$/i.exec(header);
  return match?.[1] ?? null;
}

/** Requires a valid, non-revoked host session. */
export const requireHost: RequestHandler = (req, _res, next) => {
  const token = readBearerToken(req.headers.authorization);
  if (!token) {
    next(unauthorized('missing_token', 'Authorization: Bearer <token> header required'));
    return;
  }
  verifyAccessToken(token)
    .then((host) => {
      req.hostSession = host;
      next();
    })
    .catch(next);
};

/** Visitor credential: `X-Visitor-Token: <token>` or `Authorization: Bearer <token>`. */
export function readVisitorToken(headers: { authorization?: string; 'x-visitor-token'?: string | string[] }): string {
  const raw = headers['x-visitor-token'];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  const token = fromHeader ?? readBearerToken(headers.authorization) ?? '';
  if (token.length < 20 || token.length > 128) {
    throw unauthorized('missing_visitor_token', 'Visitor credential required (X-Visitor-Token header)');
  }
  return token;
}
