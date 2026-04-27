import { describe, it, expect } from 'vitest';
import { buildPoolKey, computePoolId } from './pool-key-builder';
import { TOKENS } from '../constants';

describe('buildPoolKey', () => {
  it('sorts tokens ascending and derives tickSpacing from feeTier', () => {
    // USDC (0x07...) < UNI (0x8f...)
    const key = buildPoolKey(TOKENS.UNI.address, TOKENS.USDC.address, 3_000);
    expect(key.currency0.toLowerCase()).toBe(TOKENS.USDC.address.toLowerCase());
    expect(key.currency1.toLowerCase()).toBe(TOKENS.UNI.address.toLowerCase());
    expect(key.fee).toBe(3_000);
    expect(key.tickSpacing).toBe(60);
    expect(key.hooks).toBe('0x0000000000000000000000000000000000000000');
  });

  it('produces the same key regardless of input order', () => {
    const k1 = buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 3_000);
    const k2 = buildPoolKey(TOKENS.UNI.address, TOKENS.USDC.address, 3_000);
    expect(k1).toEqual(k2);
  });

  it('uses tickSpacing 10 for fee 500 and 200 for fee 10000', () => {
    expect(buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 500).tickSpacing).toBe(10);
    expect(buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 10_000).tickSpacing).toBe(200);
  });
});

describe('computePoolId', () => {
  it('produces a deterministic 0x-prefixed 32-byte hash', () => {
    const key = buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 3_000);
    const id = computePoolId(key);
    console.log('[pool-key-builder] UNI/USDC@3000 pool id:', id);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    // Same inputs → same id
    expect(computePoolId(key)).toBe(id);
  });
});
