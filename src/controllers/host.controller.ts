import type { Request, Response } from 'express';
import { getEnv } from '../config/env';
import { buildIceServers } from '../services/ice.service';
import { login, logout } from '../services/auth.service';
import {
  acceptMeeting,
  endMeeting,
  getAvailability,
  getHostMeeting,
  listHostMeetings,
  rejectAllPending,
  rejectMeeting,
  setAvailability,
} from '../services/meeting.service';
import { TelegramError, isTelegramConfigured, sendTelegramMessage } from '../services/telegram.service';
import { ok } from '../utils/asyncHandler';
import { AppError, conflict } from '../utils/errors';
import type { MeetingStatus } from '../models/Meeting';
import type { LoginBody } from '../validators/auth.validator';

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginBody;
  const result = await login(email, password, req.headers['user-agent']);
  ok(res, result);
}

export async function logoutHandler(req: Request, res: Response): Promise<void> {
  await logout(req.hostSession?.sid ?? '');
  ok(res, { loggedOut: true });
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as { status?: MeetingStatus; limit: number };
  ok(res, { meetings: await listHostMeetings(query) });
}

export async function get(req: Request, res: Response): Promise<void> {
  ok(res, await getHostMeeting(req.params.roomId as string));
}

export async function accept(req: Request, res: Response): Promise<void> {
  ok(res, await acceptMeeting(req.params.roomId as string));
}

export async function reject(req: Request, res: Response): Promise<void> {
  ok(res, await rejectMeeting(req.params.roomId as string));
}

export async function end(req: Request, res: Response): Promise<void> {
  ok(res, await endMeeting(req.params.roomId as string, 'host'));
}

export async function rejectPending(_req: Request, res: Response): Promise<void> {
  ok(res, { rejected: await rejectAllPending() });
}

export async function availabilityGet(_req: Request, res: Response): Promise<void> {
  ok(res, await getAvailability());
}

export async function availabilitySet(req: Request, res: Response): Promise<void> {
  ok(res, await setAvailability((req.body as { available: boolean }).available));
}

export async function iceServers(req: Request, res: Response): Promise<void> {
  ok(res, { iceServers: buildIceServers(getEnv(), `host-${req.hostSession?.sid.slice(0, 8) ?? 'x'}`) });
}

/** Sends a real test message so the host can verify the bot token / chat id. Never claims success on failure. */
export async function telegramTest(_req: Request, res: Response): Promise<void> {
  if (!isTelegramConfigured()) {
    throw conflict('telegram_not_configured', 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set');
  }
  try {
    await sendTelegramMessage('Test notification from your portfolio call backend. Telegram delivery works.');
  } catch (err) {
    const message = err instanceof TelegramError ? err.message : 'Telegram request failed';
    throw new AppError(502, 'telegram_error', message);
  }
  ok(res, { delivered: true });
}
