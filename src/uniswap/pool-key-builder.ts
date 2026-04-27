import { encodeAbiParameters, keccak256 } from 'viem';
import { FEE_TIER_TO_TICK_SPACING } from '../constants';
import type { FeeTier, PoolKey } from './types';

const ZERO_HOOKS = '0x0000000000000000000000000000000000000000' as const;

/**
 * Build a Uniswap v4 PoolKey for two tokens at a given fee tier. Tokens are
 * sorted ascending (currency0 < currency1) per Uniswap convention. Tick
 * spacing is derived from the fee tier. No hooks (zero address).
 */
export function buildPoolKey(
  tokenA: `0x${string}`,
  tokenB: `0x${string}`,
  feeTier: FeeTier,
): PoolKey {
  const a = tokenA.toLowerCase() as `0x${string}`;
  const b = tokenB.toLowerCase() as `0x${string}`;
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return {
    currency0,
    currency1,
    fee: feeTier,
    tickSpacing: FEE_TIER_TO_TICK_SPACING[feeTier],
    hooks: ZERO_HOOKS,
  };
}

/**
 * Compute the v4 pool id (bytes32) — keccak256 of the abi-encoded PoolKey.
 * Used as the lookup key for StateView reads.
 */
export function computePoolId(key: PoolKey): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
    ],
    [
      {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
      },
    ],
  );
  return keccak256(encoded);
}
