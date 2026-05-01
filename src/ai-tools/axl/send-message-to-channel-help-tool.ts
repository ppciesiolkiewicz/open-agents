import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AgentTool } from '../tool';

const SendMessageToChannelHelpInputSchema = z.object({});

export function buildSendMessageToChannelHelpTool(
  db: Database,
): AgentTool<typeof SendMessageToChannelHelpInputSchema> {
  return {
    name: 'sendMessageToChannelHelp',
    description: 'Return channel IDs this agent can currently message.',
    inputSchema: SendMessageToChannelHelpInputSchema,
    async invoke(_input, ctx) {
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) {
        throw new Error(`agent not found: ${ctx.agent.id}`);
      }
      const channels = await Promise.all(
        (source.connectedChannelIds ?? []).map(async (id) => db.agents.findAxlChannelById(id)),
      );
      const allowedChannels = channels
        .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel))
        .map((channel) => ({
          channelId: channel.id,
          name: channel.name,
          memberAgentIds: channel.memberAgentIds,
        }));
      return {
        agentId: source.id,
        allowedChannels,
      };
    },
  };
}
