import { z } from 'zod';
import { parseDuration } from '../utils/duration';

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
);
const boolStr = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(3000, 1, 65535),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Number of reverse-proxy hops in front of the app (0 = none). Required for correct client IPs / rate limits. */
    TRUST_PROXY: int(0, 0, 10),

    MONGODB_URI: z
      .string()
      .min(1)
      .refine((v) => /^mongodb(\+srv)?:\/\//.test(v), 'must start with mongodb:// or mongodb+srv://'),

    FRONTEND_ORIGINS: csv.pipe(
      z
        .array(z.string().url('must be a full origin such as https://example.com').transform((u) => new URL(u).origin))
        .min(1, 'at least one origin is required'),
    ),

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    /** e.g. "30m", "4h". Parsed to seconds. Max 24h (socket timers rely on this). */
    JWT_ACCESS_TTL: z
      .string()
      .default('4h')
      .transform((v, ctx) => {
        const seconds = parseDuration(v);
        if (seconds === null || seconds < 60 || seconds > 86_400) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a duration between 1m and 24h, e.g. "4h"' });
          return z.NEVER;
        }
        return seconds;
      }),
    HOST_EMAIL: z.string().email().max(254),
    HOST_PASSWORD_HASH: z.string().startsWith('$argon2id$', 'must be an Argon2id hash (npm run hash-password)'),

    TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
    TELEGRAM_CHAT_ID: z.string().min(1).optional(),
    TELEGRAM_TIMEOUT_MS: int(8000, 1000, 60_000),
    NOTIFY_MAX_ATTEMPTS: int(6, 1, 20),
    NOTIFY_RETRY_BASE_SECONDS: int(5, 1, 3600),
    NOTIFY_POLL_INTERVAL_MS: int(5000, 500, 600_000),

    HOST_DASHBOARD_URL: z.string().url().optional(),
    PUBLIC_API_URL: z.string().url().optional(),

    MEETING_REQUEST_TTL_SECONDS: int(300, 10, 86_400),
    /** An accepted meeting whose call never reaches in_progress within this window expires. */
    ACCEPTED_START_TIMEOUT_SECONDS: int(120, 10, 3600),
    MEETING_DURATION_LIMIT_SECONDS: int(1800, 60, 86_400),
    /** A started call whose peer is gone for this long is ended by the system. */
    RECONNECT_GRACE_SECONDS: int(30, 5, 600),
    MAX_ACTIVE_CALLS: int(1, 1, 20),
    MAX_PENDING_REQUESTS: int(20, 1, 1000),
    MAX_PENDING_PER_VISITOR: int(1, 1, 100),
    MEETING_RETENTION_DAYS: int(30, 1, 3650),
    SWEEP_INTERVAL_MS: int(5000, 500, 600_000),
    HOST_DEFAULT_AVAILABLE: boolStr.default('true'),

    // Keep direct WebRTC connectivity working out of the box; configure TURN_URL for restrictive NATs.
    STUN_URLS: csv.default('stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478'),
    /** One or more comma-separated turn:/turns: URLs. */
    TURN_URL: csv.default(''),
    TURN_USERNAME: z.string().min(1).optional(),
    TURN_PASSWORD: z.string().min(1).optional(),
    /** If set, short-lived TURN REST credentials are generated (coturn `use-auth-secret`). Preferred. */
    TURN_SHARED_SECRET: z.string().min(16).optional(),
    TURN_CREDENTIAL_TTL_SECONDS: int(3600, 60, 86_400),

    RATE_LIMIT_GLOBAL_PER_MINUTE: int(300, 1, 100_000),
    HOST_API_RATE_LIMIT_PER_MINUTE: int(120, 1, 100_000),
    MEETING_CREATE_RATE_LIMIT_MAX: int(5, 1, 100_000),
    MEETING_CREATE_RATE_LIMIT_WINDOW_SECONDS: int(900, 1, 86_400),
    LOGIN_RATE_LIMIT_MAX: int(10, 1, 100_000),
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: int(900, 1, 86_400),
    SOCKET_EVENT_LIMIT_PER_10S: int(200, 10, 10_000),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (Boolean(env.TELEGRAM_BOT_TOKEN) !== Boolean(env.TELEGRAM_CHAT_ID)) {
      issue('TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together (or both omitted)');
    }
    if (env.TURN_URL.length > 0 && !env.TURN_SHARED_SECRET && !(env.TURN_USERNAME && env.TURN_PASSWORD)) {
      issue('TURN_URL', 'set TURN_SHARED_SECRET, or both TURN_USERNAME and TURN_PASSWORD');
    }
    if (env.NODE_ENV === 'production') {
      if (env.FRONTEND_ORIGINS.some((o) => !o.startsWith('https://'))) {
        issue('FRONTEND_ORIGINS', 'all origins must use https:// in production');
      }
      if (/change|example|secret|password/i.test(env.JWT_ACCESS_SECRET)) {
        issue('JWT_ACCESS_SECRET', 'looks like a placeholder; generate a random secret');
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses and validates configuration. Throws a readable error (without secret values) on failure. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  cached = result.data;
  return result.data;
}

export function getEnv(): Env {
  return cached ?? loadEnv();
}
