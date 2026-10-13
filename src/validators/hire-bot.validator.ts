import { z } from 'zod';

const chatMessage = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(1000),
  })
  .strict();

export const hireBotBody = z
  .object({
    message: z.string().trim().min(1).max(1000),
    mode: z.enum(['fun', 'serious']).default('serious'),
    history: z.array(chatMessage).max(10).default([]),
  })
  .strict();

export type HireBotBody = z.infer<typeof hireBotBody>;
