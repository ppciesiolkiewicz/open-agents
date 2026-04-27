import { z } from 'zod';
import type { AgentTool } from '../tool';

const nativeInput = z.object({}).describe('No arguments required');
const tokenInput = z.object({
  tokenAddress: z.string().describe('ERC-20 contract address (0x-prefixed)'),
});

export function buildWalletBalanceTools(): [
  AgentTool<typeof nativeInput>,
  AgentTool<typeof tokenInput>,
] {
  const nativeBalance: AgentTool<typeof nativeInput> = {
    name: 'getNativeBalance',
    description:
      'Read the native (ETH) balance for the agent wallet on Unichain. Returns JSON {raw, unit:"wei"}. raw is a bigint as string.',
    inputSchema: nativeInput,
    async invoke(_input, ctx) {
      const wei = await ctx.wallet.getNativeBalance();
      return { raw: wei.toString(), unit: 'wei' };
    },
  };

  const tokenBalance: AgentTool<typeof tokenInput> = {
    name: 'getTokenBalance',
    description:
      'Read the ERC-20 balance for the agent wallet on Unichain. Returns JSON {tokenAddress, raw}. raw is a bigint as string in token base units (no decimal scaling).',
    inputSchema: tokenInput,
    async invoke({ tokenAddress }, ctx) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
        throw new Error(`tokenAddress must be a 0x-prefixed 40-char hex address; got ${tokenAddress}`);
      }
      const raw = await ctx.wallet.getTokenBalance(tokenAddress as `0x${string}`);
      return { tokenAddress, raw: raw.toString() };
    },
  };

  return [nativeBalance, tokenBalance];
}
