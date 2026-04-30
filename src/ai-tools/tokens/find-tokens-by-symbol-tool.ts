import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({
  symbol: z.string().min(1).describe('Token symbol, e.g. "USDC". Case-sensitive (matches the canonical symbol).'),
});

export function buildFindTokensBySymbolTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'findTokensBySymbol',
    description:
      'Look up Unichain tokens by symbol from the catalog. Multiple matches possible (forks share symbols). Returns JSON {tokens: [{address, symbol, name, decimals, coingeckoId}]}.',
    inputSchema,
    async invoke({ symbol }) {
      const tokens = await db.tokens.findBySymbol(symbol, UNICHAIN.chainId);
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
