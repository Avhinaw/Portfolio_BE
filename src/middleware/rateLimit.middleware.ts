import type { Request, Response } from 'express';
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Env } from '../config/env';

function limiter(options: Partial<Options>): RateLimitRequestHandler {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        ok: false,
        error: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again later.' },
      });
    },
    ...options,
  });
}

export interface RateLimiters {
  global: RateLimitRequestHandler;
  createMeeting: RateLimitRequestHandler;
  visitorAction: RateLimitRequestHandler;
  loginByIp: RateLimitRequestHandler;
  loginByEmail: RateLimitRequestHandler;
  hostApi: RateLimitRequestHandler;
}

/**
 * Default in-memory stores are per process. Behind several instances use a shared store
 * (e.g. rate-limit-redis) so limits are enforced globally. See README "Scaling".
 */
export function createRateLimiters(env: Env): RateLimiters {
  return {
    global: limiter({ windowMs: 60_000, limit: env.RATE_LIMIT_GLOBAL_PER_MINUTE }),
    createMeeting: limiter({
      windowMs: env.MEETING_CREATE_RATE_LIMIT_WINDOW_SECONDS * 1000,
      limit: env.MEETING_CREATE_RATE_LIMIT_MAX,
    }),
    visitorAction: limiter({ windowMs: 60_000, limit: 30 }),
    // Brute-force protection: only FAILED logins count, keyed by IP...
    loginByIp: limiter({
      windowMs: env.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
      limit: env.LOGIN_RATE_LIMIT_MAX,
      skipSuccessfulRequests: true,
    }),
    // ...and separately by target e-mail so a botnet cannot spread guesses across many IPs.
    loginByEmail: limiter({
      windowMs: env.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
      limit: env.LOGIN_RATE_LIMIT_MAX * 2,
      skipSuccessfulRequests: true,
      keyGenerator: (req: Request) => {
        const email = (req.body as { email?: unknown } | undefined)?.email;
        return `login-email:${typeof email === 'string' ? email.toLowerCase().slice(0, 254) : 'unknown'}`;
      },
    }),
    hostApi: limiter({ windowMs: 60_000, limit: env.HOST_API_RATE_LIMIT_PER_MINUTE }),
  };
}
