import { z } from 'zod';
import { parseUnits } from 'viem';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import type { Database } from '../../database/database';
import type { FeeTier } from '../../uniswap/types';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({
  tokenInAddress: z.string().describe('0x-prefixed Unichain address of input token.'),
  tokenOutAddress: z.string().describe('0x-prefixed Unichain address of output token.'),
  amountIn: z.string().describe('Human-decimal string of input amount, e.g. "0.5". Server resolves decimals from the token catalog.'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000.'),
});

export function buildUniswapQuoteTool(
  svc: UniswapService,
  db: Database,
): AgentTool<typeof inputSchema> {
  return {
    name: 'getUniswapQuoteExactIn',
    description:
      'Quote a Uniswap v4 swap on Unichain for an exact input amount. Pass token addresses and a human-decimal amountIn. Returns JSON {amountOut, amountOutFormatted, feeTier, tokenIn, tokenOut}.',
    inputSchema,
    async invoke({ tokenInAddress, tokenOutAddress, amountIn, feeTier }) {
      const inAddr = tokenInAddress.toLowerCase();
      const outAddr = tokenOutAddress.toLowerCase();
      const tokens = await db.tokens.findManyByAddresses([inAddr, outAddr], UNICHAIN.chainId);
      const map = new Map(tokens.map((t) => [t.address, t]));
      const inToken = map.get(inAddr);
      const outToken = map.get(outAddr);
      if (!inToken) throw new Error(`token not in catalog: ${tokenInAddress}`);
      if (!outToken) throw new Error(`token not in catalog: ${tokenOutAddress}`);

      const tier: FeeTier = feeTier ?? 3_000;
      const amountInRaw = parseUnits(amountIn, inToken.decimals);
      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address as `0x${string}`,
        tokenOut: outToken.address as `0x${string}`,
        amountIn: amountInRaw,
        feeTier: tier,
      });
      return {
        amountOut: quote.amountOut.toString(),
        amountOutFormatted: (Number(quote.amountOut) / 10 ** outToken.decimals).toString(),
        feeTier: tier,
        tokenIn: inToken.symbol,
        tokenOut: outToken.symbol,
      };
    },
  };
}
