import { z } from 'zod';

export const loginBody = z
  .object({
    email: z.string().max(254).email(),
    password: z.string().min(1).max(256),
  })
  .strict();

export type LoginBody = z.infer<typeof loginBody>;
