import { describe, it, expect } from 'vitest';
import { PoolStateReader } from './pool-state-reader';
import { buildPoolKey } from './pool-key-builder';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../constants';

describe('PoolStateReader (live, Unichain)', () => {
  const reader = new PoolStateReader({
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });

  it('reads slot0 for the UNI/USDC 3000-fee pool', async () => {
    const key = buildPoolKey(USDC_ON_UNICHAIN.address, UNI_ON_UNICHAIN.address, 3_000);
    const slot0 = await reader.readSlot0(key);
    console.log('[pool-state-reader] slot0:', {
      sqrtPriceX96: slot0.sqrtPriceX96.toString(),
      tick: slot0.tick,
      protocolFee: slot0.protocolFee,
      lpFee: slot0.lpFee,
    });
    expect(slot0.sqrtPriceX96).toBeGreaterThan(0n);
  });

  it('reads liquidity for the UNI/USDC 3000-fee pool', async () => {
    const key = buildPoolKey(USDC_ON_UNICHAIN.address, UNI_ON_UNICHAIN.address, 3_000);
    const liquidity = await reader.readLiquidity(key);
    console.log('[pool-state-reader] liquidity:', liquidity.toString());
    expect(liquidity).toBeGreaterThanOrEqual(0n);
  });
});
