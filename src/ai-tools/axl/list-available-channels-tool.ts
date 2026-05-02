import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AgentTool } from '../tool';

const ListAvailableChannelsInputSchema = z.object({});

export function buildListAvailableChannelsTool(
  db: Database,
): AgentTool<typeof ListAvailableChannelsInputSchema> {
  return {
    name: 'listAvailableChannels',
    description:
      'Return the list of channels this agent can message, with their UUID (channelId) and human name. Always call this before sendMessageToChannel to get the correct channelId — never use a channel name as the ID.',
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
