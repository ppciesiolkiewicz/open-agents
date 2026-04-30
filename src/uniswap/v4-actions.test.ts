import { describe, it, expect } from 'vitest';
import { buildUniversalRouterV4Swap } from './v4-actions';
import { buildPoolKey } from './pool-key-builder';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../constants';

describe('buildUniversalRouterV4Swap', () => {
  it('produces a single command byte 0x10 (V4_SWAP)', () => {
    const poolKey = buildPoolKey(USDC_ON_UNICHAIN.address, UNI_ON_UNICHAIN.address, 3_000);
    const { commands } = buildUniversalRouterV4Swap({
      poolKey,
      zeroForOne: true,
      amountIn: 1_000_000n,
      amountOutMinimum: 0n,
      inputCurrency: poolKey.currency0,
      outputCurrency: poolKey.currency1,
    });
    expect(commands).toBe('0x10');
  });

  it('produces a non-empty input blob with the expected three actions packed', () => {
    const poolKey = buildPoolKey(USDC_ON_UNICHAIN.address, UNI_ON_UNICHAIN.address, 3_000);
    const { inputs } = buildUniversalRouterV4Swap({
      poolKey,
      zeroForOne: true,
      amountIn: 1_000_000n,
      amountOutMinimum: 100n,
      inputCurrency: poolKey.currency0,
      outputCurrency: poolKey.currency1,
    });
    console.log('[v4-actions] input blob length (chars):', inputs[0].length);
    expect(inputs[0]).toMatch(/^0x[0-9a-f]+$/);
    expect(inputs[0]).toContain('06');
    expect(inputs[0]).toContain('0c');
    expect(inputs[0]).toContain('0f');
  });
});
