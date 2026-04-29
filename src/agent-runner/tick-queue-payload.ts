import { z } from 'zod';

export const TickPayloadSchema = z.discriminatedUnion('trigger', [
  z.object({
    trigger: z.literal('scheduled'),
    agentId: z.string().min(1),
    enqueuedAt: z.number().int().nonnegative(),
  }),
  z.object({
    trigger: z.literal('chat'),
    agentId: z.string().min(1),
    chatContent: z.string().min(1),
    enqueuedAt: z.number().int().nonnegative(),
  }),
]);

export type TickPayload = z.infer<typeof TickPayloadSchema>;
