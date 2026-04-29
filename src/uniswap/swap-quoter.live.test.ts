import { describe, it, expect } from 'vitest';
import { SwapQuoter } from './swap-quoter';
import { TOKENS } from '../constants';

describe('SwapQuoter (live, Unichain)', () => {
  const quoter = new SwapQuoter({
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });

  it('quotes 1 USDC → UNI', async () => {
    const quote = await quoter.quoteExactInputSingle({
      tokenIn: TOKENS.USDC.address,
      tokenOut: TOKENS.UNI.address,
      amountIn: 1_000_000n,
      feeTier: 3_000,
    });
    console.log('[swap-quoter] 1 USDC → UNI:', quote.amountOut.toString(), 'wei');
    expect(quote.amountOut).toBeGreaterThan(0n);
  });

  it('quotes 0.1 UNI → USDC', async () => {
    const quote = await quoter.quoteExactInputSingle({
      tokenIn: TOKENS.UNI.address,
      tokenOut: TOKENS.USDC.address,
      amountIn: 100_000_000_000_000_000n,
      feeTier: 3_000,
    });
    console.log('[swap-quoter] 0.1 UNI → USDC:', quote.amountOut.toString(), 'wei');
    expect(quote.amountOut).toBeGreaterThan(0n);
  });
});
