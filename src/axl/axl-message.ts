import { z } from 'zod';

export const AxlMessageSchema = z.object({
  targetAgentId: z.string().min(1),
  chatContent: z.string().min(1),
});

export type AxlMessage = z.infer<typeof AxlMessageSchema>;
