import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AxlClient } from '../../axl/axl-client';
import type { AgentTool } from '../tool';

const SendMessageToAgentInputSchema = z.object({
  targetAgentId: z.string().min(1),
  message: z.string().min(1),
});

export function buildSendMessageToAgentTool(
  db: Database,
  axlClient: AxlClient,
  localPeerId: string,
): AgentTool<typeof SendMessageToAgentInputSchema> {
  return {
    name: 'sendMessageToAgent',
    description:
      'Send a message to a connected peer agent via the AXL P2P network. The recipient runs a normal tick with your message as input.',
    inputSchema: SendMessageToAgentInputSchema,
    async invoke(input, ctx) {
      if (input.targetAgentId === ctx.agent.id) {
        throw new Error('cannot send a message to self');
      }
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) throw new Error(`agent not found: ${ctx.agent.id}`);
      if (!(source.connectedAgentIds ?? []).includes(input.targetAgentId)) {
        throw new Error(`agent ${input.targetAgentId} is not connected to ${ctx.agent.id}`);
      }
      const target = await db.agents.findById(input.targetAgentId);
      if (!target) throw new Error(`target agent not found: ${input.targetAgentId}`);
      if (target.userId !== source.userId) {
        throw new Error('cross-user agent messaging is not allowed');
      }

      const peerId = target.axlPeerId ?? localPeerId;
      const chatContent = [
        `Message from agent ${source.id}, use "sendMessageToAgent" to reply`,
        '',
        input.message,
      ].join('\n');

      await axlClient.send(peerId, { targetAgentId: target.id, chatContent });

      return {
        delivered: true,
        targetAgentId: target.id,
        targetAgentName: target.name,
      };
    },
  };
}
