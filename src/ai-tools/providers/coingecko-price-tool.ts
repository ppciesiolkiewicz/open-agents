import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import type { Database } from '../../database/database';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({
  coingeckoId: z.string().optional().describe('CoinGecko coin id, e.g. "usd-coin". Pass either this OR tokenAddress.'),
  tokenAddress: z.string().optional().describe('0x-prefixed Unichain token address. Resolved to coingeckoId via the catalog. Pass either this OR coingeckoId.'),
});

export function buildCoingeckoPriceTool(
  coingecko: CoingeckoService,
  db: Database,
): AgentTool<typeof inputSchema> {
  return {
    name: 'fetchTokenPriceUSD',
    description:
      'Fetch a token\'s current USD price from CoinGecko. Pass either coingeckoId (preferred) or tokenAddress (Unichain). Returns JSON {price, currency, source, coingeckoId}.',
    inputSchema,
    async invoke({ coingeckoId, tokenAddress }) {
      let id = coingeckoId;
      if (!id) {
        if (!tokenAddress) {
          throw new Error('one of coingeckoId or tokenAddress is required');
        }
        const tok = await db.tokens.findByAddress(tokenAddress, UNICHAIN.chainId);
        if (!tok) throw new Error(`token not in catalog: ${tokenAddress}`);
        if (!tok.coingeckoId) throw new Error(`token has no coingeckoId: ${tokenAddress}`);
        id = tok.coingeckoId;
      }
      const price = await coingecko.fetchTokenPriceUSD(id);
      return { price, currency: 'USD', source: 'coingecko', coingeckoId: id };
    },
  };
}
