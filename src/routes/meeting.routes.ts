import { Router } from 'express';
import * as controller from '../controllers/meeting.controller';
import type { RateLimiters } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validation.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { createMeetingBody, roomIdParams } from '../validators/meeting.validator';

export function createMeetingRouter(limits: RateLimiters): Router {
  const router = Router();

  router.get('/availability', limits.visitorAction, asyncHandler(controller.availability));

  router.post(
    '/meetings',
    limits.createMeeting,
    validate({ body: createMeetingBody }),
    asyncHandler(controller.create),
  );

  router.get(
    '/meetings/:roomId/status',
    limits.visitorAction,
    validate({ params: roomIdParams }),
    asyncHandler(controller.status),
  );

  router.post(
    '/meetings/:roomId/cancel',
    limits.visitorAction,
    validate({ params: roomIdParams }),
    asyncHandler(controller.cancel),
  );

  router.get(
    '/meetings/:roomId/ice-servers',
    limits.visitorAction,
    validate({ params: roomIdParams }),
    asyncHandler(controller.iceServers),
  );

  return router;
}
