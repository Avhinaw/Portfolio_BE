import type { CorsOptions } from 'cors';
import type { Env } from './env';

export function buildCorsOptions(env: Env): CorsOptions {
  return {
    origin(origin, callback) {
      // No Origin header: non-browser client (curl, server-to-server). CORS is a browser mechanism.
      if (!origin || env.FRONTEND_ORIGINS.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Visitor-Token'],
    credentials: false,
    maxAge: 600,
  };
}
