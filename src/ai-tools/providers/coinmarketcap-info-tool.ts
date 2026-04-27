import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { CoinMarketCapService } from '../../providers/coinmarketcap/coinmarketcap-service';

const inputSchema = z.object({
  symbol: z.string().describe('Token symbol like USDC or UNI'),
});

export function buildCoinMarketCapInfoTool(svc: CoinMarketCapService): AgentTool<typeof inputSchema> {
  return {
    name: 'fetchTokenInfoBySymbol',
    description:
      'Fetch project metadata (id, name, slug) for a token symbol from CoinMarketCap.',
    inputSchema,
    async invoke({ symbol }) {
      const info = await svc.fetchTokenInfoBySymbol(symbol.toUpperCase());
      return { id: info.id, name: info.name, symbol: info.symbol, slug: info.slug };
    },
  };
}
