import { z } from 'zod';
import { encodeFunctionData, erc20Abi, parseUnits, formatUnits } from 'viem';
import { randomUUID } from 'node:crypto';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({
  tokenAddress: z
    .string()
    .describe('0x-prefixed Unichain ERC-20 token address. Must be in the agent allowlist.'),
  toAddress: z
    .string()
    .describe('0x-prefixed recipient wallet address on Unichain.'),
  amountHuman: z
    .string()
    .describe('Human-readable decimal amount to transfer, e.g. "1.5" for 1.5 USDC.'),
});

export function buildERC20TransferTool(
  db: Database,
  coingecko: CoingeckoService,
): AgentTool<typeof inputSchema> {
  return {
    name: 'transferERC20Token',
    description:
      'Transfer ERC-20 tokens to any address on Unichain. Token must be in the agent allowlist. Risk gate enforces maxTradeUSD. Amount is a human-readable decimal (e.g. "1.5" for 1.5 USDC). Returns JSON {transactionId, hash, status, tokenAddress, toAddress, amountRaw, amountFormatted, symbol}.',
    inputSchema,
    async invoke({ tokenAddress, toAddress, amountHuman }, ctx) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
        throw new Error(`tokenAddress must be a 0x-prefixed 40-char hex address; got ${tokenAddress}`);
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
        throw new Error(`toAddress must be a 0x-prefixed 40-char hex address; got ${toAddress}`);
      }

      const tokenAddr = tokenAddress.toLowerCase();
      const allowSet = new Set(ctx.agent.allowedTokens.map((a) => a.toLowerCase()));
      if (!allowSet.has(tokenAddr)) {
        throw new Error(`token not in agent allowlist: ${tokenAddress}`);
      }

      const token = await db.tokens.findByAddress(tokenAddr, UNICHAIN.chainId);
      if (!token) throw new Error(`token not in catalog: ${tokenAddress}`);
      if (!token.coingeckoId) {
        throw new Error(`token missing coingeckoId for USD risk math: ${tokenAddress}`);
      }

      const amountRaw = parseUnits(amountHuman, token.decimals);
      const priceUSD = await coingecko.fetchTokenPriceUSD(token.coingeckoId);
      const transferUSD = (Number(amountRaw) / 10 ** token.decimals) * priceUSD;
      const maxTradeUSD = ctx.agent.riskLimits.maxTradeUSD;
      if (transferUSD > maxTradeUSD) {
        throw new Error(
          `transfer ${transferUSD.toFixed(2)} USD exceeds agent maxTradeUSD ${maxTradeUSD}`,
        );
      }

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [toAddress as `0x${string}`, amountRaw],
      });

      const receipt = await ctx.wallet.signAndSendTransaction({
        to: tokenAddress as `0x${string}`,
        data,
      });

      const gasUsed = receipt.gasUsed;
      const gasPriceWei = receipt.effectiveGasPrice;
      const tx = {
        id: `tx-${randomUUID()}`,
        agentId: ctx.agent.id,
        hash: receipt.transactionHash,
        chainId: UNICHAIN.chainId,
        fromAddress: (receipt.from ?? ctx.wallet.getAddress()) as string,
        toAddress: tokenAddress,
        tokenIn: {
          tokenAddress: tokenAddr,
          symbol: token.symbol,
          amountRaw: amountRaw.toString(),
          decimals: token.decimals,
        },
        gasUsed: gasUsed.toString(),
        gasPriceWei: gasPriceWei.toString(),
        gasCostWei: (gasUsed * gasPriceWei).toString(),
        status: receipt.status === 'success' ? ('success' as const) : ('failed' as const),
        blockNumber: receipt.blockNumber === 0n ? null : Number(receipt.blockNumber),
        timestamp: Date.now(),
      };
      await db.transactions.insert(tx);

      return {
        transactionId: tx.id,
        hash: tx.hash,
        status: tx.status,
        tokenAddress: tokenAddr,
        toAddress,
        amountRaw: amountRaw.toString(),
        amountFormatted: formatUnits(amountRaw, token.decimals),
        symbol: token.symbol,
      };
    },
  };
}
