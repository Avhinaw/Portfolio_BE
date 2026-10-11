import type { Request, Response } from 'express';
import { getEnv } from '../config/env';
import { readVisitorToken } from '../middleware/auth.middleware';
import { buildIceServers } from '../services/ice.service';
import {
  authenticateVisitor,
  cancelMeeting,
  createMeeting,
  getPublicAvailability,
  getPublicStatus,
  requireSignalingState,
} from '../services/meeting.service';
import { ok } from '../utils/asyncHandler';
import { visitorFingerprint } from '../utils/crypto';
import type { CreateMeetingBody } from '../validators/meeting.validator';

export async function create(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateMeetingBody;
  const { meeting, visitorToken } = await createMeeting({
    visitorName: body.visitorName,
    visitorMessage: body.visitorMessage,
    fingerprint: visitorFingerprint(req.ip),
  });
  ok(
    res,
    {
      id: meeting._id.toString(),
      roomId: meeting.roomId,
      status: meeting.status,
      createdAt: meeting.createdAt,
      expiresAt: meeting.expiresAt,
      // Returned exactly once. The server stores only its hash. Keep it in memory/sessionStorage.
      visitorToken,
    },
    201,
  );
}

export async function status(req: Request, res: Response): Promise<void> {
  ok(res, await getPublicStatus(req.params.roomId as string));
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const token = readVisitorToken(req.headers);
  ok(res, await cancelMeeting(req.params.roomId as string, token));
}

export async function availability(_req: Request, res: Response): Promise<void> {
  ok(res, await getPublicAvailability());
}

export async function iceServers(req: Request, res: Response): Promise<void> {
  const roomId = req.params.roomId as string;
  await authenticateVisitor(roomId, readVisitorToken(req.headers));
  await requireSignalingState(roomId);
  ok(res, { iceServers: buildIceServers(getEnv(), roomId) });
}
