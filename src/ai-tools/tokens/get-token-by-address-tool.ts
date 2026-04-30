import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({
  address: z.string().describe('0x-prefixed Unichain token address.'),
});

export function buildGetTokenByAddressTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'getTokenByAddress',
    description:
      'Get token info from the Unichain catalog by address. Returns JSON token | null.',
    inputSchema,
    async invoke({ address }) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error(`address must be 0x-prefixed 40-char hex; got ${address}`);
      }
      const t = await db.tokens.findByAddress(address, UNICHAIN.chainId);
      return t
        ? {
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            coingeckoId: t.coingeckoId,
          }
        : null;
    },
  };
}
