import { Router } from 'express';
import { pingDatabase } from '../config/database';
import { asyncHandler } from '../utils/asyncHandler';

export const healthRouter = Router();

/** Public, minimal: no connection strings, versions, hostnames or error details. */
healthRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const databaseUp = await pingDatabase();
    res.status(databaseUp ? 200 : 503).json({
      ok: databaseUp,
      data: {
        status: databaseUp ? 'ok' : 'degraded',
        database: databaseUp ? 'up' : 'down',
        uptimeSeconds: Math.round(process.uptime()),
      },
    });
  }),
);
