import type { Request, Response } from 'express';
import { answerHireBot } from '../services/hire-bot.service';
import { ok } from '../utils/asyncHandler';
import type { HireBotBody } from '../validators/hire-bot.validator';

export async function chat(req: Request, res: Response): Promise<void> {
  const { message, mode, history } = req.body as HireBotBody;
  ok(res, { reply: await answerHireBot({ message, mode, history }) });
}
