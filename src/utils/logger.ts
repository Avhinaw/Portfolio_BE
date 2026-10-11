import pino from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-visitor-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.accessToken',
  '*.visitorToken',
  '*.token',
  '*.authorization',
  '*.botToken',
  '*.secret',
];

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

export const logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(process.env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
