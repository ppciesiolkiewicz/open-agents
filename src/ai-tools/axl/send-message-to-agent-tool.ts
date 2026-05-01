import { z } from 'zod';
import type { Database } from '../../database/database';
import type { TickQueue } from '../../agent-runner/tick-queue';
import type { AgentTool } from '../tool';

const SendMessageToAgentInputSchema = z.object({
  targetAgentId: z.string().min(1),
  message: z.string().min(1),
});

export function buildSendMessageToAgentTool(
  db: Database,
  tickQueue: TickQueue,
): AgentTool<typeof SendMessageToAgentInputSchema> {
  return {
    name: 'sendMessageToAgent',
    description:
      'Enqueue the same chat job as POST /agents/{id}/messages for a connected peer: the recipient runs a normal tick, logs user_message, and updates memory/tools itself.',
    inputSchema: SendMessageToAgentInputSchema,
    async invoke(input, ctx) {
      if (input.targetAgentId === ctx.agent.id) {
        throw new Error('cannot send a message to self');
      }
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) {
        throw new Error(`agent not found: ${ctx.agent.id}`);
      }
      if (!(source.connectedAgentIds ?? []).includes(input.targetAgentId)) {
        throw new Error(`agent ${input.targetAgentId} is not connected to ${ctx.agent.id}`);
      }
      const target = await db.agents.findById(input.targetAgentId);
      if (!target) {
        throw new Error(`target agent not found: ${input.targetAgentId}`);
      }
      if (target.userId !== source.userId) {
        throw new Error('cross-user agent messaging is not allowed');
      }

      const chatContent = [
        `Message from agent ${source.id}, use "sendMessageToAgent" to reply`,
        '',
        input.message,
      ].join('\n');

      const { position } = await tickQueue.enqueue({
        trigger: 'chat',
        agentId: target.id,
        chatContent,
      });

      return {
        delivered: true,
        targetAgentId: target.id,
        targetAgentName: target.name,
        queuePosition: position,
      };
    },
  };
}
