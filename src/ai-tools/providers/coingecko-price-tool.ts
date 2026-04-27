import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { TOKENS } from '../../constants';

const inputSchema = z.object({
  symbol: z.string().describe('Token symbol like USDC or UNI'),
});

export function buildCoingeckoPriceTool(svc: CoingeckoService): AgentTool<typeof inputSchema> {
  return {
    name: 'fetchTokenPriceUSD',
    description:
      'Fetch the current USD price for a token symbol (e.g. "USDC", "UNI"). Returns JSON {symbol, priceUSD}.',
    inputSchema,
    async invoke({ symbol }) {
      const upper = symbol.toUpperCase();
      const known = (TOKENS as Record<string, { coingeckoId: string }>)[upper];
      const id = known?.coingeckoId ?? symbol.toLowerCase();
      const price = await svc.fetchTokenPriceUSD(id);
      return { symbol: upper, priceUSD: price };
    },
  };
}
