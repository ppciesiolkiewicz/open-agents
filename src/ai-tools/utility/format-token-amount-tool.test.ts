import { describe, it, expect } from 'vitest';
import { buildFormatTokenAmountTool } from './format-token-amount-tool';

describe('formatTokenAmount tool', () => {
  const tool = buildFormatTokenAmountTool();

  it('formats USDC raw to 6-decimal human', async () => {
    const out = await tool.invoke({ rawAmount: '1234567', decimals: 6 }, {} as never);
    expect(out).toEqual({ formatted: '1.234567' });
  });

  it('formats UNI raw with 18 decimals', async () => {
    const out = await tool.invoke({ rawAmount: '1500000000000000000', decimals: 18 }, {} as never);
    expect(out).toEqual({ formatted: '1.5' });
  });

  it('handles zero', async () => {
    const out = await tool.invoke({ rawAmount: '0', decimals: 18 }, {} as never);
    expect(out).toEqual({ formatted: '0' });
  });

  it('rejects non-bigint string', async () => {
    await expect(tool.invoke({ rawAmount: '1.5', decimals: 6 }, {} as never)).rejects.toThrow();
  });
});
