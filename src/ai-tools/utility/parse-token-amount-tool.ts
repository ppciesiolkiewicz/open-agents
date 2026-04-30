import { z } from 'zod';
import { parseUnits } from 'viem';
import type { AgentTool } from '../tool';

const inputSchema = z.object({
  humanAmount: z.string().describe('Human decimal string, e.g. "0.01" or "1.5" or "100".'),
  decimals: z.number().int().min(0).max(36).describe('Token decimals.'),
});

export function buildParseTokenAmountTool(): AgentTool<typeof inputSchema> {
  return {
    name: 'parseTokenAmount',
    description:
      'Convert a human-decimal token amount to a raw bigint string in base units. Returns JSON {rawAmount}.',
    inputSchema,
    async invoke({ humanAmount, decimals }) {
      const raw = parseUnits(humanAmount, decimals);
      return { rawAmount: raw.toString() };
    },
  };
}
