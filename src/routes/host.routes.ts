import { Router } from 'express';
import * as controller from '../controllers/host.controller';
import { requireHost } from '../middleware/auth.middleware';
import type { RateLimiters } from '../middleware/rateLimit.middleware';
import { validate } from '../middleware/validation.middleware';
import { asyncHandler } from '../utils/asyncHandler';
import { loginBody } from '../validators/auth.validator';
import { availabilityBody, hostListQuery, roomIdParams } from '../validators/meeting.validator';

export function createHostRouter(limits: RateLimiters): Router {
  const router = Router();

  // Public (but heavily rate-limited): obtain an access token.
  router.post(
    '/auth/login',
    limits.loginByIp,
    validate({ body: loginBody }),
    limits.loginByEmail,
    asyncHandler(controller.loginHandler),
  );

  // Everything below requires a valid host session.
  router.use(limits.hostApi, requireHost);

  router.post('/auth/logout', asyncHandler(controller.logoutHandler));

  router.get('/meetings', validate({ query: hostListQuery }), asyncHandler(controller.list));
  router.post('/meetings/bulk/reject-pending', asyncHandler(controller.rejectPending));
  router.get('/meetings/:roomId', validate({ params: roomIdParams }), asyncHandler(controller.get));
  router.post('/meetings/:roomId/accept', validate({ params: roomIdParams }), asyncHandler(controller.accept));
  router.post('/meetings/:roomId/reject', validate({ params: roomIdParams }), asyncHandler(controller.reject));
  router.post('/meetings/:roomId/end', validate({ params: roomIdParams }), asyncHandler(controller.end));

  router.get('/availability', asyncHandler(controller.availabilityGet));
  router.put('/availability', validate({ body: availabilityBody }), asyncHandler(controller.availabilitySet));

  router.get('/ice-servers', asyncHandler(controller.iceServers));
  router.post('/telegram/test', asyncHandler(controller.telegramTest));

  return router;
}
