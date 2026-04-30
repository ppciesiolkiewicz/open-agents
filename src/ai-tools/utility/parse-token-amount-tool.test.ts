import { describe, it, expect } from 'vitest';
import { buildParseTokenAmountTool } from './parse-token-amount-tool';

describe('parseTokenAmount tool', () => {
  const tool = buildParseTokenAmountTool();

  it('parses 0.01 USDC', async () => {
    const out = await tool.invoke({ humanAmount: '0.01', decimals: 6 }, {} as never);
    expect(out).toEqual({ rawAmount: '10000' });
  });

  it('parses 1.5 UNI', async () => {
    const out = await tool.invoke({ humanAmount: '1.5', decimals: 18 }, {} as never);
    expect(out).toEqual({ rawAmount: '1500000000000000000' });
  });

  it('parses integer', async () => {
    const out = await tool.invoke({ humanAmount: '100', decimals: 6 }, {} as never);
    expect(out).toEqual({ rawAmount: '100000000' });
  });

  it('rejects non-numeric', async () => {
    await expect(tool.invoke({ humanAmount: 'oops', decimals: 6 }, {} as never)).rejects.toThrow();
  });
});
