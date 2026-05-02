import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AgentTool } from '../tool';

const ListAvailableChannelsInputSchema = z.object({});

export function buildListAvailableChannelsTool(
  db: Database,
): AgentTool<typeof ListAvailableChannelsInputSchema> {
  return {
    name: 'listAvailableChannels',
    description: 'List AXL channels this agent is connected to and can message.',
    inputSchema: ListAvailableChannelsInputSchema,
    async invoke(_input, ctx) {
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) {
        throw new Error(`agent not found: ${ctx.agent.id}`);
      }
      const channels = await Promise.all(
        (source.connectedChannelIds ?? []).map(async (id) => db.agents.findAxlChannelById(id)),
      );
      const connectedChannels = channels
        .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel))
        .map((channel) => ({
          channelId: channel.id,
          name: channel.name,
          memberAgentIds: channel.memberAgentIds,
        }));
      return {
        agentId: source.id,
        channels: connectedChannels,
      };
    },
  };
}
