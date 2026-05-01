import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AgentTool } from '../tool';

const SendMessageToAgentHelpInputSchema = z.object({});

export function buildSendMessageToAgentHelpTool(db: Database): AgentTool<typeof SendMessageToAgentHelpInputSchema> {
  return {
    name: 'sendMessageToAgentHelp',
    description: 'Return which connected agents are currently allowed message targets.',
    inputSchema: SendMessageToAgentHelpInputSchema,
    async invoke(_input, ctx) {
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) {
        throw new Error(`agent not found: ${ctx.agent.id}`);
      }
      const targets = await Promise.all(
        (source.connectedAgentIds ?? []).map(async (id) => db.agents.findById(id)),
      );
      const allowedTargets = targets
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map((agent) => ({
          agentId: agent.id,
          name: agent.name,
        }));
      return {
        agentId: source.id,
        allowedTargets,
      };
    },
  };
}
