import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AxlClient } from '../../axl/axl-client';
import type { AgentTool } from '../tool';

const SendMessageToAgentInputSchema = z.object({
  targetAgentId: z
    .string()
    .uuid()
    .describe(
      'The UUID of the target agent (e.g. "a1b2c3d4-..."). NOT the agent name. Call sendMessageToAgentHelp first to get the list of connected agent IDs and their names.',
    ),
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
      'Send a message to a connected peer agent via AXL P2P. IMPORTANT: targetAgentId must be a UUID — call sendMessageToAgentHelp first to look up agent IDs by name. Do not guess or use the agent name as the ID.',
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
      if (!target.axlPeerId) {
        console.warn(`[sendMessageToAgent] target agent ${target.id} has no axlPeerId — falling back to local node`);
      }
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
