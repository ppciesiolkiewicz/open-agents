import type { FeeTier } from '../constants/fee-tiers';
export type { FeeTier };

// Uniswap v4 PoolKey shape — the canonical identifier for a v4 pool.
export interface PoolKey {
  currency0: `0x${string}`;   // sorted ascending
  currency1: `0x${string}`;
  fee: FeeTier;
  tickSpacing: number;
  hooks: `0x${string}`;       // 0x000...0 for no hooks
}

// Slot0 unpacked from PoolManager / StateView.
export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

// One quote round-tripping back from the V4Quoter for an exact-input swap.
export interface Quote {
  amountIn: bigint;
  amountOut: bigint;
  feeTier: FeeTier;
  // Best-effort price impact estimate, in basis points; undefined if we couldn't
  // derive it (no spot price available).
  priceImpactBps?: number;
}

export interface SwapParams {
  tokenIn: `0x${string}`;
  tokenInDecimals: number;
  tokenOut: `0x${string}`;
  tokenOutDecimals: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  feeTier: FeeTier;
}
