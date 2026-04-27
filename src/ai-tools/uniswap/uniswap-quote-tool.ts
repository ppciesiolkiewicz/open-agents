import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import { TOKENS, type TokenSymbol } from '../../constants';
import type { FeeTier } from '../../uniswap/types';

const inputSchema = z.object({
  tokenIn: z.string().describe('Token symbol like USDC or UNI'),
  tokenOut: z.string().describe('Token symbol like USDC or UNI'),
  amountIn: z.string().describe('Raw bigint amount of tokenIn (in tokenIn decimals) as a string'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000 (most liquid for UNI/USDC).'),
});

export function buildUniswapQuoteTool(svc: UniswapService): AgentTool<typeof inputSchema> {
  return {
    name: 'getUniswapQuoteExactIn',
    description:
      'Quote a Uniswap v4 swap on Unichain for an exact input amount. Returns JSON {amountOut, feeTier}. Use before executeUniswapSwapExactIn to size your trade.',
    inputSchema,
    async invoke({ tokenIn, tokenOut, amountIn, feeTier }) {
      const inToken = TOKENS[tokenIn.toUpperCase() as TokenSymbol];
      const outToken = TOKENS[tokenOut.toUpperCase() as TokenSymbol];
      if (!inToken || !outToken) {
        throw new Error(`Unknown token symbol(s). Known: ${Object.keys(TOKENS).join(', ')}`);
      }
      const tier: FeeTier = feeTier ?? 3_000;
      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address,
        tokenOut: outToken.address,
        amountIn: BigInt(amountIn),
        feeTier: tier,
      });
      return {
        amountOut: quote.amountOut.toString(),
        feeTier: tier,
        tokenIn: inToken.symbol,
        tokenOut: outToken.symbol,
      };
    },
  };
}
