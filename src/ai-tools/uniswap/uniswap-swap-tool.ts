import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { TOKENS, type TokenSymbol } from '../../constants';
import type { FeeTier } from '../../uniswap/types';

const inputSchema = z.object({
  tokenIn: z.string().describe('Token symbol like USDC or UNI'),
  tokenOut: z.string().describe('Token symbol like USDC or UNI'),
  amountIn: z.string().describe('Raw bigint amount of tokenIn (in tokenIn decimals) as a string'),
  slippageBps: z.number().int().min(1).max(10_000).optional()
    .describe('Max slippage in basis points (e.g. 50 = 0.5%). Defaults to agent.riskLimits.maxSlippageBps; capped at it.'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000 (most liquid for UNI/USDC).'),
});

export function buildUniswapSwapTool(
  svc: UniswapService,
  coingecko: CoingeckoService,
): AgentTool<typeof inputSchema> {
  return {
    name: 'executeUniswapSwapExactIn',
    description:
      'Execute a Uniswap v4 single-pool exact-input swap on Unichain. Risk gate enforces agent.riskLimits.maxTradeUSD and maxSlippageBps. Returns JSON {transactionId, hash, status, opened?: positionId, closed?: {positionId, realizedPnlUSD}}.',
    inputSchema,
    async invoke({ tokenIn, tokenOut, amountIn, slippageBps, feeTier }, ctx) {
      const inToken = TOKENS[tokenIn.toUpperCase() as TokenSymbol];
      const outToken = TOKENS[tokenOut.toUpperCase() as TokenSymbol];
      if (!inToken || !outToken) {
        throw new Error(`Unknown token symbol(s). Known: ${Object.keys(TOKENS).join(', ')}`);
      }

      const maxSlippageBps = ctx.agent.riskLimits.maxSlippageBps;
      const requestedSlippage = slippageBps ?? maxSlippageBps;
      if (requestedSlippage > maxSlippageBps) {
        throw new Error(`requested slippage ${requestedSlippage}bps exceeds agent maxSlippageBps ${maxSlippageBps}`);
      }

      const tier: FeeTier = feeTier ?? 3_000;

      // Quote first to know amountOut for slippage + risk math.
      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address,
        tokenOut: outToken.address,
        amountIn: BigInt(amountIn),
        feeTier: tier,
      });

      // USD notional via Coingecko.
      const inPriceUSD = await coingecko.fetchTokenPriceUSD(inToken.coingeckoId);
      const outPriceUSD = await coingecko.fetchTokenPriceUSD(outToken.coingeckoId);
      const inputUSD = (Number(BigInt(amountIn)) / 10 ** inToken.decimals) * inPriceUSD;
      const expectedOutputUSD = (Number(quote.amountOut) / 10 ** outToken.decimals) * outPriceUSD;

      const maxTradeUSD = ctx.agent.riskLimits.maxTradeUSD;
      if (inputUSD > maxTradeUSD) {
        throw new Error(`trade ${inputUSD.toFixed(2)} USD exceeds agent maxTradeUSD ${maxTradeUSD}`);
      }

      // amountOutMinimum = amountOut * (10000 - slippage) / 10000
      const amountOutMinimum = (quote.amountOut * BigInt(10_000 - requestedSlippage)) / 10_000n;

      const result = await svc.executeSwapExactIn(
        {
          tokenIn: { tokenAddress: inToken.address, symbol: inToken.symbol, decimals: inToken.decimals, amountRaw: amountIn },
          tokenOut: { tokenAddress: outToken.address, symbol: outToken.symbol, decimals: outToken.decimals, amountRaw: quote.amountOut.toString() },
          amountOutMinimum,
          feeTier: tier,
          inputUSD,
          expectedOutputUSD,
        },
        ctx.agent,
        ctx.wallet,
      );

      return {
        transactionId: result.swapTx.id,
        hash: result.swapTx.hash,
        status: result.swapTx.status,
        amountIn,
        amountOutEstimated: quote.amountOut.toString(),
        amountOutMinimum: amountOutMinimum.toString(),
        feeTier: tier,
        slippageBps: requestedSlippage,
        approvalTxIds: result.approvalTxs.map((t) => t.id),
        ...(result.opened ? { openedPositionId: result.opened.id } : {}),
        ...(result.closed
          ? { closedPositionId: result.closed.id, realizedPnlUSD: result.closed.realizedPnlUSD }
          : {}),
      };
    },
  };
}
