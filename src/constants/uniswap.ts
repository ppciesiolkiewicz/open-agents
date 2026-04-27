// Uniswap v4 deployments on Unichain mainnet (chainId 130).
// Source: https://developers.uniswap.org/contracts/v4/deployments (verified 2026-04-27).
export const UNISWAP_V4_UNICHAIN = {
  poolManager: '0x1f98400000000000000000000000000000000004',
  universalRouter: '0xef740bf23acae26f6492b10de645d6b98dc8eaf3',
  v4Quoter: '0x333e3c607b141b18ff6de9f258db6e77fe7491e0',
  stateView: '0x86e8631a016f9068c3f085faf484ee3f5fdee8f2',
  positionManager: '0x4529a01c7a0410167c5740c487a8de60232617bf',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const satisfies Record<string, `0x${string}`>;

// Uniswap v4 fee tier → tick spacing mapping. Each fee tier has a fixed
// canonical tick spacing per Uniswap v4 PoolManager.
export const FEE_TIER_TO_TICK_SPACING = {
  500: 10,
  3_000: 60,
  10_000: 200,
} as const satisfies Record<number, number>;

// UniversalRouter command byte for v4 swap.
export const UNIVERSAL_ROUTER_V4_SWAP_COMMAND = 0x10 as const;

// V4 router action selectors (from @uniswap/v4-periphery Actions library).
export const V4_ACTION = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
} as const;

// Default deadline buffer (seconds) added to block.timestamp when building swap txs.
export const SWAP_DEADLINE_BUFFER_SECONDS = 60;
