import { z } from 'zod';
import { parseUnits } from 'viem';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import type { Database } from '../../database/database';
import type { FeeTier } from '../../uniswap/types';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({
  tokenInAddress: z.string().describe('0x-prefixed Unichain address of input token. MUST be in the agent allowlist.'),
  tokenOutAddress: z.string().describe('0x-prefixed Unichain address of output token. MUST be in the agent allowlist.'),
  amountIn: z.string().describe('Human-decimal input amount, e.g. "0.01" for 0.01 USDC. Server resolves decimals.'),
  slippageBps: z.number().int().min(1).max(10_000).optional()
    .describe('Max slippage in basis points. Defaults to and is capped at agent.riskLimits.maxSlippageBps.'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000.'),
});

export function buildUniswapSwapTool(
  svc: UniswapService,
  coingecko: CoingeckoService,
  db: Database,
): AgentTool<typeof inputSchema> {
  return {
    name: 'executeUniswapSwapExactIn',
    description:
      'Execute a Uniswap v4 single-pool exact-input swap on Unichain. Token addresses must be in agent.allowedTokens. Risk gate enforces maxTradeUSD + maxSlippageBps. Returns JSON {transactionId, hash, status, opened?, closed?}.',
    inputSchema,
    async invoke({ tokenInAddress, tokenOutAddress, amountIn, slippageBps, feeTier }, ctx) {
      const inAddr = tokenInAddress.toLowerCase();
      const outAddr = tokenOutAddress.toLowerCase();
      const allowSet = new Set(ctx.agent.allowedTokens.map((a) => a.toLowerCase()));

      if (!allowSet.has(inAddr)) {
        throw new Error(`token not in agent allowlist: ${tokenInAddress}`);
      }
      if (!allowSet.has(outAddr)) {
        throw new Error(`token not in agent allowlist: ${tokenOutAddress}`);
      }

      const tokens = await db.tokens.findManyByAddresses([inAddr, outAddr], UNICHAIN.chainId);
      const map = new Map(tokens.map((t) => [t.address, t]));
      const inToken = map.get(inAddr);
      const outToken = map.get(outAddr);
      if (!inToken) throw new Error(`token not in catalog: ${tokenInAddress}`);
      if (!outToken) throw new Error(`token not in catalog: ${tokenOutAddress}`);
      if (!inToken.coingeckoId) throw new Error(`tokenIn missing coingeckoId for USD risk math: ${inToken.address}`);
      if (!outToken.coingeckoId) throw new Error(`tokenOut missing coingeckoId for USD risk math: ${outToken.address}`);

      const maxSlippageBps = ctx.agent.riskLimits.maxSlippageBps;
      const requestedSlippage = slippageBps ?? maxSlippageBps;
      if (requestedSlippage > maxSlippageBps) {
        throw new Error(`requested slippage ${requestedSlippage}bps exceeds agent maxSlippageBps ${maxSlippageBps}`);
      }

      const tier: FeeTier = feeTier ?? 3_000;
      const amountInRaw = parseUnits(amountIn, inToken.decimals);

      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address as `0x${string}`,
        tokenOut: outToken.address as `0x${string}`,
        amountIn: amountInRaw,
        feeTier: tier,
      });

      const inPriceUSD = await coingecko.fetchTokenPriceUSD(inToken.coingeckoId);
      const outPriceUSD = await coingecko.fetchTokenPriceUSD(outToken.coingeckoId);
      const inputUSD = (Number(amountInRaw) / 10 ** inToken.decimals) * inPriceUSD;
      const expectedOutputUSD = (Number(quote.amountOut) / 10 ** outToken.decimals) * outPriceUSD;

      const maxTradeUSD = ctx.agent.riskLimits.maxTradeUSD;
      if (inputUSD > maxTradeUSD) {
        throw new Error(`trade ${inputUSD.toFixed(2)} USD exceeds agent maxTradeUSD ${maxTradeUSD}`);
      }

      const amountOutMinimum = (quote.amountOut * BigInt(10_000 - requestedSlippage)) / 10_000n;

      const result = await svc.executeSwapExactIn(
        {
          tokenIn: { tokenAddress: inToken.address, symbol: inToken.symbol, decimals: inToken.decimals, amountRaw: amountInRaw.toString() },
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
        amountIn: amountInRaw.toString(),
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
