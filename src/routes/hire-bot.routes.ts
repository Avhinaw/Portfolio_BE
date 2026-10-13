import { Router } from 'express';
import * as controller from '../controllers/hire-bot.controller';
import type { RateLimiters } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validation.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { hireBotBody } from '../validators/hire-bot.validator';

export function createHireBotRouter(limits: RateLimiters): Router {
  const router = Router();

  router.post(
    '/hire-bot/chat',
    limits.hireBot,
    validate({ body: hireBotBody }),
    asyncHandler(controller.chat),
  );

  return router;
}
