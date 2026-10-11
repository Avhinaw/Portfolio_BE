import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { buildCorsOptions } from './config/cors';
import { getEnv, type Env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { createRateLimiters } from './middleware/rateLimit.middleware';
import { createHostRouter } from './routes/host.routes';
import { healthRouter } from './routes/health.routes';
import { createMeetingRouter } from './routes/meeting.routes';
import { logger } from './utils/logger';

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createApp(env: Env = getEnv()): Express {
  const app = express();
  const limits = createRateLimiters(env);

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );
  app.use(helmet());
  app.use(cors(buildCorsOptions(env)));
  app.use(noStore);
  app.use(limits.global);
  app.use(express.json({ limit: '16kb', type: 'application/json' }));

  app.use('/api', healthRouter);
  app.use('/api', createMeetingRouter(limits));
  app.use('/api/host', createHostRouter(limits));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
