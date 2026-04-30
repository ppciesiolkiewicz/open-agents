import { z } from 'zod';
import { formatUnits } from 'viem';
import type { AgentTool } from '../tool';

const inputSchema = z.object({
  rawAmount: z.string().describe('Bigint as string in token base units, e.g. "1234567" for 1.234567 USDC.'),
  decimals: z.number().int().min(0).max(36).describe('Token decimals, e.g. 6 for USDC, 18 for UNI.'),
});

export function buildFormatTokenAmountTool(): AgentTool<typeof inputSchema> {
  return {
    name: 'formatTokenAmount',
    description:
      'Convert a raw bigint token amount to a human-decimal string. Returns JSON {formatted}. Use this for displaying balances/amounts to the operator.',
    inputSchema,
    async invoke({ rawAmount, decimals }) {
      const raw = BigInt(rawAmount);
      return { formatted: formatUnits(raw, decimals) };
    },
  };
}
