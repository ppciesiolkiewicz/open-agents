import { z } from 'zod';
import { formatUnits, erc20Abi, createPublicClient, http } from 'viem';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN, resolveUnichainRpcUrl } from '../../constants';
import type { Env } from '../../config/env';

const nativeInput = z.object({}).describe('No arguments required');
const tokenInput = z.object({
  tokenAddress: z.string().describe('ERC-20 contract address (0x-prefixed)'),
});

export function buildWalletBalanceTools(db: Database, env: Env): [
  AgentTool<typeof nativeInput>,
  AgentTool<typeof tokenInput>,
] {
  const nativeBalance: AgentTool<typeof nativeInput> = {
    name: 'getNativeBalance',
    description:
      'Read the native (ETH) balance for the agent wallet on Unichain. Returns JSON {raw, formatted, decimals, symbol}. raw is wei as a string; formatted is the human ETH amount.',
    inputSchema: nativeInput,
    async invoke(_input, ctx) {
      const wei = await ctx.wallet.getNativeBalance();
      return {
        raw: wei.toString(),
        formatted: formatUnits(wei, 18),
        decimals: 18,
        symbol: 'ETH',
      };
    },
  };

  const tokenBalance: AgentTool<typeof tokenInput> = {
    name: 'getTokenBalance',
    description:
      'Read the ERC-20 balance for the agent wallet on Unichain. Returns JSON {tokenAddress, raw, formatted, decimals, symbol}. Decimals + symbol resolved from the token catalog (or on-chain if unknown).',
    inputSchema: tokenInput,
    async invoke({ tokenAddress }, ctx) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
        throw new Error(`tokenAddress must be a 0x-prefixed 40-char hex address; got ${tokenAddress}`);
      }
      const lower = tokenAddress.toLowerCase();
      const raw = await ctx.wallet.getTokenBalance(tokenAddress as `0x${string}`);

      const cataloged = await db.tokens.findByAddress(lower, UNICHAIN.chainId);
      let decimals: number;
      let symbol: string;
      if (cataloged) {
        decimals = cataloged.decimals;
        symbol = cataloged.symbol;
      } else {
        const client = createPublicClient({ transport: http(resolveUnichainRpcUrl(env)) });
        const [d, s] = await Promise.all([
          client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
          client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }).catch(() => '<unknown>'),
        ]);
        decimals = d as number;
        symbol = s as string;
      }
      return {
        tokenAddress: lower,
        raw: raw.toString(),
        formatted: formatUnits(raw, decimals),
        decimals,
        symbol,
      };
    },
  };

  return [nativeBalance, tokenBalance];
}
