import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ ok: false, error: { code: 'route_not_found', message: 'Route not found' } });
};

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      ok: false,
      error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  // body-parser errors (malformed JSON, payload too large, unsupported charset...)
  const http = err as HttpLikeError;
  if (http && typeof http === 'object' && http.type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: { code: 'invalid_json', message: 'Malformed JSON body' } });
    return;
  }
  if (http && typeof http === 'object' && http.type === 'entity.too.large') {
    res.status(413).json({ ok: false, error: { code: 'payload_too_large', message: 'Request body is too large' } });
    return;
  }

  // Anything else is a bug or infrastructure problem: log details server-side, return nothing internal.
  (req.log ?? logger).error(
    { err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : 'non-error thrown' },
    'unhandled error',
  );
  res.status(500).json({ ok: false, error: { code: 'internal_error', message: 'Internal server error' } });
};
