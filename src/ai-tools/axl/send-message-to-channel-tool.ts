import { z } from 'zod';
import type { Database } from '../../database/database';
import type { TickQueue } from '../../agent-runner/tick-queue';
import type { AgentTool } from '../tool';

const SendMessageToChannelInputSchema = z.object({
  channelId: z.string().min(1),
  message: z.string().min(1),
});

export function buildSendMessageToChannelTool(
  db: Database,
  tickQueue: TickQueue,
): AgentTool<typeof SendMessageToChannelInputSchema> {
  return {
    name: 'sendMessageToChannel',
    description:
      'Enqueue a chat job to every other agent in a connected AXL channel.',
    inputSchema: SendMessageToChannelInputSchema,
    async invoke(input, ctx) {
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) {
        throw new Error(`agent not found: ${ctx.agent.id}`);
      }
      if (!(source.connectedChannelIds ?? []).includes(input.channelId)) {
        throw new Error(`agent ${ctx.agent.id} is not connected to channel ${input.channelId}`);
      }
      const channel = await db.agents.findAxlChannelById(input.channelId);
      if (!channel) {
        throw new Error(`channel not found: ${input.channelId}`);
      }
      if (channel.userId !== source.userId) {
        throw new Error('cross-user channel messaging is not allowed');
      }

      const targetAgentIds = channel.memberAgentIds.filter((id) => id !== source.id);
      const deliveredTargets: Array<{ agentId: string; name: string; queuePosition: number }> = [];
      for (const targetAgentId of targetAgentIds) {
        const target = await db.agents.findById(targetAgentId);
        if (!target || target.userId !== source.userId) continue;
        const chatContent = [
          `Message from agent ${source.id} in channel ${channel.id} (${channel.name})`,
          '',
          input.message,
        ].join('\n');
        const { position } = await tickQueue.enqueue({
          trigger: 'chat',
          agentId: target.id,
          chatContent,
        });
        deliveredTargets.push({
          agentId: target.id,
          name: target.name,
          queuePosition: position,
        });
      }

      return {
        delivered: true,
        channelId: channel.id,
        channelName: channel.name,
        deliveredCount: deliveredTargets.length,
        deliveredTargets,
      };
    },
  };
}
