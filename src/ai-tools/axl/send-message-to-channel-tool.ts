import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AxlClient } from '../../axl/axl-client';
import type { AgentTool } from '../tool';

const SendMessageToChannelInputSchema = z.object({
  channelId: z.string().min(1),
  message: z.string().min(1),
});

export function buildSendMessageToChannelTool(
  db: Database,
  axlClient: AxlClient,
  localPeerId: string,
): AgentTool<typeof SendMessageToChannelInputSchema> {
  return {
    name: 'sendMessageToChannel',
    description:
      'Send a message to all other agents in a connected AXL channel via the AXL P2P network.',
    inputSchema: SendMessageToChannelInputSchema,
    async invoke(input, ctx) {
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) throw new Error(`agent not found: ${ctx.agent.id}`);
      if (!(source.connectedChannelIds ?? []).includes(input.channelId)) {
        throw new Error(`agent ${ctx.agent.id} is not connected to channel ${input.channelId}`);
      }
      const channel = await db.agents.findAxlChannelById(input.channelId);
      if (!channel) throw new Error(`channel not found: ${input.channelId}`);
      if (channel.userId !== source.userId) {
        throw new Error('cross-user channel messaging is not allowed');
      }

      const targetAgentIds = channel.memberAgentIds.filter((id) => id !== source.id);
      const deliveredTargets: Array<{ agentId: string; name: string }> = [];
      const failedTargets: Array<{ agentId: string; error: string }> = [];

      for (const targetAgentId of targetAgentIds) {
        const target = await db.agents.findById(targetAgentId);
        if (!target || target.userId !== source.userId) continue;

        const peerId = target.axlPeerId ?? localPeerId;
        if (!target.axlPeerId) {
          console.warn(`[sendMessageToChannel] agent ${target.id} has no axlPeerId — falling back to local node`);
        }
        const chatContent = [
          `Message from agent ${source.id} in channel ${channel.id} (${channel.name})`,
          '',
          input.message,
        ].join('\n');

        try {
          await axlClient.send(peerId, { targetAgentId: target.id, chatContent });
          deliveredTargets.push({ agentId: target.id, name: target.name });
        } catch (err) {
          failedTargets.push({ agentId: target.id, error: String(err) });
        }
      }

      return {
        delivered: deliveredTargets.length > 0,
        channelId: channel.id,
        channelName: channel.name,
        deliveredCount: deliveredTargets.length,
        deliveredTargets,
        failedCount: failedTargets.length,
        failedTargets,
      };
    },
  };
}
