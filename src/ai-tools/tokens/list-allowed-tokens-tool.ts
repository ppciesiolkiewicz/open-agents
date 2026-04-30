import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({}).describe('No arguments required');

export function buildListAllowedTokensTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'listAllowedTokens',
    description:
      'List the tokens this agent is allowed to trade. Returns JSON {tokens: [{address, symbol, name, decimals, coingeckoId}]}. Empty array means swapping is disabled — ask the operator to update the agent.',
    inputSchema,
    async invoke(_input, ctx) {
      if (ctx.agent.allowedTokens.length === 0) {
        return { tokens: [] };
      }
      const tokens = await db.tokens.findManyByAddresses(
        ctx.agent.allowedTokens,
        UNICHAIN.chainId,
      );
      return {
        tokens: tokens.map((t) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          coingeckoId: t.coingeckoId,
        })),
      };
    },
  };
}
