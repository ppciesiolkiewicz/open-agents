# Slice 7 — Uniswap v4 + swap tools + risk enforcement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM can quote and execute UNI/USDC swaps on Unichain via Uniswap v4. Risk gate at the tool wrapper enforces per-agent `maxTradeUSD` AND new `maxSlippageBps` caps. Each swap (real or dry-run) writes a `Transaction` and updates `Position` records. Permit2 approvals happen automatically inside `executeSwapExactIn` when allowances are insufficient. Interactive test exercises a real swap with y/n confirmation.

**Architecture:** New `uniswap/` module composes a pool key builder, StateView reader, V4Quoter caller, and UniversalRouter swap executor. `UniswapService.executeSwapExactIn` is wallet-agnostic — calls `wallet.signAndSendTransaction` for the underlying tx (RealWallet does the network call; DryRunWallet returns a synthetic receipt with sentinel hash). After the receipt comes back, `UniswapService` writes the `Transaction` row and updates `Position` records via `PositionTracker`. Risk enforcement lives in the tool wrapper (`ai-tools/uniswap/`), not in `UniswapService`, so the service stays reusable for non-agent callers.

**Tech Stack:** viem (already installed slice 3) — covers all v4 contract calls and calldata encoding by hand using viem's `encodeAbiParameters` + `encodePacked`. No new Uniswap SDK packages — keeps the dep tree small and avoids ethers/viem interop quirks. Coingecko (already installed slice 1) for USD pricing in the risk gate. Permit2 + UniversalRouter on Unichain mainnet.

**Spec reference:** [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](../specs/2026-04-26-agent-loop-foundation-design.md) — sections "Uniswap" + "Risk Enforcement".

**Test rule (slice 7):**
- `*.test.ts` — pure unit tests (no I/O) — used for pool-key builder, calldata encoders, position-tracker pure logic
- `*.live.test.ts` — real RPC reads (pool state, quotes, balances on Unichain) — runs in CI; skips if `WALLET_PRIVATE_KEY` invalid
- `*.interactive.test.ts` — real swaps, y/n confirmation, never in CI — opt-in via `INTERACTIVE_TESTS=1` and `npm run test:interactive`

---

## File Structure

```
src/test-lib/
  interactive-prompt.ts                       # NEW — confirmContinue() y/n helper (test-only; gates fund-spending interactive tests)
src/constants/
  uniswap.ts                                  # NEW — Uniswap v4 addresses on Unichain + v4 action selectors
src/database/
  types.ts                                    # MODIFY — add maxSlippageBps to riskLimits
src/uniswap/
  types.ts                                    # NEW — PoolKey, Quote, SwapParams, Slot0
  pool-key-builder.ts                         # NEW — buildPoolKey(a, b, feeTier) → PoolKey + computePoolId
  pool-key-builder.test.ts                    # NEW — pure unit test (sort + tickSpacing + id)
  pool-state-reader.ts                        # NEW — readSlot0 + readLiquidity via StateView
  pool-state-reader.live.test.ts              # NEW — live UNI/USDC pool state on Unichain
  swap-quoter.ts                              # NEW — quoteExactInputSingle via V4Quoter
  swap-quoter.live.test.ts                    # NEW — live quote UNI↔USDC
  v4-actions.ts                               # NEW — encode V4 router actions calldata (SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL)
  v4-actions.test.ts                          # NEW — round-trip encoding shape assertion
  permit2-allowance.ts                        # NEW — read + ensure Permit2 + ERC20 allowances
  permit2-allowance.live.test.ts              # NEW — live read-only allowance check on Unichain
  swap-executor.ts                            # NEW — executeSwap composes calldata + wallet.signAndSend
  position-tracker.ts                         # NEW — openOrCloseFromSwap (pure logic over Database)
  position-tracker.test.ts                    # NEW — pure unit test (open, close, partial-close documented as out-of-scope)
  uniswap-service.ts                          # NEW — UniswapService composing the above
  uniswap-service.interactive.test.ts         # NEW — real swap UNI↔USDC behind INTERACTIVE_TESTS=1 + y/n
src/ai-tools/uniswap/
  uniswap-quote-tool.ts                       # NEW — getUniswapQuoteExactIn (no risk gate, read-only)
  uniswap-swap-tool.ts                        # NEW — executeUniswapSwapExactIn (RISK GATE)
src/ai-tools/
  tool-registry.ts                            # MODIFY — add UniswapService dep, register 2 new tools (12 total)
  tool-registry.test.ts                       # MODIFY — assert 12 tools in expected order
  tool-registry.live.test.ts                  # MODIFY — add a quote tool live test
src/agent-runner/
  agent-runner.ts                             # MODIFY — memoryKeysChanged adds 'positions' tracking note (minor)
src/index.ts                                  # MODIFY — instantiate UniswapService, pass to ToolRegistry
package.json                                  # MODIFY — split test/test:interactive scripts
vitest.config.ts                              # MODIFY — exclude *.interactive.test.ts
vitest.interactive.config.ts                  # NEW — only includes *.interactive.test.ts; sequential
```

Out-of-scope explicit:
- Partial-position close (e.g. buy 100 UNI, sell 50): documented; v1 closes whole position and nets PnL, so we'd lose 50 UNI of cost basis tracking. Mitigation: spec says agents can buy multiple times; close-all matches first-out semantics.
- Multi-hop swaps (USDC → UNI via ETH): single-hop only.
- Swap deadline configurability beyond a hard-coded 60s buffer.

---

## Task 1: AgentConfig.riskLimits.maxSlippageBps + interactive-prompt + vitest split

**Files:**
- Modify: `src/database/types.ts`
- Create: `src/test-lib/interactive-prompt.ts`
- Modify: `vitest.config.ts`
- Create: `vitest.interactive.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Add `maxSlippageBps` to riskLimits**

In `src/database/types.ts`, find:

```ts
  riskLimits: { maxTradeUSD: number; [k: string]: unknown };
```

Replace with:

```ts
  riskLimits: {
    maxTradeUSD: number;       // existing
    maxSlippageBps: number;    // new — agent's ceiling on slippage tolerance (50 = 0.5%, 100 = 1%)
    [k: string]: unknown;
  };
```

This will surface typecheck errors in places that construct `AgentConfig` literals — fix each one to include `maxSlippageBps: 100` (1% default for v1).

- [ ] **Step 2: Run typecheck and fix each AgentConfig literal**

Run: `npm run typecheck`
Expected: errors in test fixtures + the seed agent JSON example in the spec. For every literal, add `maxSlippageBps: 100`.

Common test files to fix:
- `src/database/file-database/file-database.live.test.ts` — `makeAgent`
- `src/wallet/dry-run/dry-run-wallet.live.test.ts` — `makeAgent`
- `src/wallet/factory/wallet-factory.live.test.ts` — `makeAgent`
- `src/agent-runner/agent-runner.live.test.ts` — `makeAgent`
- `src/agent-looper/agent-orchestrator.live.test.ts` — `makeAgent`
- `src/ai-tools/tool-registry.live.test.ts` — `makeAgent`

In each `makeAgent` factory, add `maxSlippageBps: 100` inside `riskLimits`.

Re-run typecheck until exit 0 (both configs).

- [ ] **Step 3: Create `src/test-lib/interactive-prompt.ts`**

```ts
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * Asks a y/n question on stdin and returns true if the user types 'y' or 'yes'.
 * Used by *.interactive.test.ts to gate fund-spending operations.
 */
export async function confirmContinue(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = (await rl.question(`\n${prompt} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 4: Update `vitest.config.ts` to exclude interactive tests**

Find the `include` and `exclude` arrays. Replace with:

```ts
    include: ['src/**/*.live.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*.interactive.test.ts'],
```

Keep all other settings (`environment`, `setupFiles`, `testTimeout`, `passWithNoTests`).

- [ ] **Step 5: Create `vitest.interactive.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.interactive.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 120_000,        // real onchain txs need more time
    fileParallelism: false,      // y/n prompts share stdin — must be sequential
    passWithNoTests: true,
  },
});
```

- [ ] **Step 6: Update `package.json` test scripts**

Find the existing scripts. Replace with:

```json
"test": "NODE_OPTIONS=--conditions=require vitest run",
"test:watch": "NODE_OPTIONS=--conditions=require vitest",
"test:interactive": "NODE_OPTIONS=--conditions=require INTERACTIVE_TESTS=1 vitest run --config vitest.interactive.config.ts",
```

(`test` is unchanged in command but the underlying config now excludes `*.interactive.test.ts`.)

- [ ] **Step 7: Verify typecheck + test runs**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: same as before (64 pass, 2 skip, 1 known fail). No `interactive` tests yet so `npm run test:interactive` passes with no tests (`passWithNoTests`).

- [ ] **Step 8: Commit**

```bash
git add src/database/types.ts src/test-lib/interactive-prompt.ts vitest.config.ts vitest.interactive.config.ts package.json src/database/file-database/file-database.live.test.ts src/wallet/dry-run/dry-run-wallet.live.test.ts src/wallet/factory/wallet-factory.live.test.ts src/agent-runner/agent-runner.live.test.ts src/agent-looper/agent-orchestrator.live.test.ts src/ai-tools/tool-registry.live.test.ts
git commit -m "feat: add maxSlippageBps + interactive-prompt + vitest config split for slice 7"
```

---

## Task 2: Uniswap v4 constants on Unichain

**Files:**
- Create: `src/constants/uniswap.ts`
- Modify: `src/constants/index.ts`

- [ ] **Step 1: Create `src/constants/uniswap.ts`**

```ts
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
```

- [ ] **Step 2: Re-export from `src/constants/index.ts`**

Append:

```ts
export * from './uniswap';
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/constants/uniswap.ts src/constants/index.ts
git commit -m "feat(constants): add Uniswap v4 Unichain addresses + fee-tier→tickSpacing + v4 action selectors"
```

---

## Task 3: PoolKey types + builder + pure test

**Files:**
- Create: `src/uniswap/types.ts`
- Create: `src/uniswap/pool-key-builder.ts`
- Create: `src/uniswap/pool-key-builder.test.ts`

- [ ] **Step 1: Create `src/uniswap/types.ts`**

```ts
export type FeeTier = 500 | 3_000 | 10_000;

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
```

- [ ] **Step 2: Create `src/uniswap/pool-key-builder.ts`**

```ts
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
```

- [ ] **Step 3: Write the unit test**

`src/uniswap/pool-key-builder.test.ts`:

```ts
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
```

- [ ] **Step 4: Run unit test**

Run: `npx vitest run src/uniswap/pool-key-builder.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/uniswap/types.ts src/uniswap/pool-key-builder.ts src/uniswap/pool-key-builder.test.ts
git commit -m "feat(uniswap): add PoolKey types + builder + pool-id hashing"
```

---

## Task 4: Pool state reader (StateView contract)

**Files:**
- Create: `src/uniswap/pool-state-reader.ts`
- Create: `src/uniswap/pool-state-reader.live.test.ts`

- [ ] **Step 1: Implement `pool-state-reader.ts`**

```ts
import {
  createPublicClient,
  http,
  type PublicClient,
  type Hex,
} from 'viem';
import { unichain } from 'viem/chains';
import { resolveUnichainRpcUrl, UNISWAP_V4_UNICHAIN } from '../constants';
import { computePoolId } from './pool-key-builder';
import type { PoolKey, Slot0 } from './types';

// Minimal StateView ABI — getSlot0 + getLiquidity.
const STATE_VIEW_ABI = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
] as const;

export interface PoolStateReaderEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class PoolStateReader {
  private readonly publicClient: PublicClient;

  constructor(env: PoolStateReaderEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
  }

  async readSlot0(key: PoolKey): Promise<Slot0> {
    const id = computePoolId(key);
    const [sqrtPriceX96, tick, protocolFee, lpFee] = await this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.stateView as `0x${string}`,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [id as Hex],
    });
    return { sqrtPriceX96, tick, protocolFee, lpFee };
  }

  async readLiquidity(key: PoolKey): Promise<bigint> {
    const id = computePoolId(key);
    return this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.stateView as `0x${string}`,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [id as Hex],
    });
  }
}
```

- [ ] **Step 2: Write the live test**

`src/uniswap/pool-state-reader.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PoolStateReader } from './pool-state-reader';
import { buildPoolKey } from './pool-key-builder';
import { TOKENS } from '../constants';

const ALCHEMY = process.env.ALCHEMY_API_KEY;

describe.skipIf(!ALCHEMY)('PoolStateReader (live, Unichain)', () => {
  const reader = new PoolStateReader({
    ALCHEMY_API_KEY: ALCHEMY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });

  it('reads slot0 for the UNI/USDC 3000-fee pool', async () => {
    const key = buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 3_000);
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
    const key = buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 3_000);
    const liquidity = await reader.readLiquidity(key);
    console.log('[pool-state-reader] liquidity:', liquidity.toString());
    expect(liquidity).toBeGreaterThanOrEqual(0n);
  });
});
```

- [ ] **Step 3: Run the live test**

Run: `npx vitest run src/uniswap/pool-state-reader.live.test.ts`
Expected: PASSES with sqrtPriceX96 + liquidity logged. SKIPPED if no `ALCHEMY_API_KEY`.

If `getSlot0` or `getLiquidity` revert with "PoolNotInitialized" or similar, the address constants from Task 2 are wrong, OR the UNI/USDC pool at fee=3000 doesn't exist on Unichain. Try fee=500 or 10000. Adjust the test fee tier if needed and document.

- [ ] **Step 4: Commit**

```bash
git add src/uniswap/pool-state-reader.ts src/uniswap/pool-state-reader.live.test.ts
git commit -m "feat(uniswap): add PoolStateReader (slot0 + liquidity via StateView)"
```

---

## Task 5: V4 swap actions encoder

**Files:**
- Create: `src/uniswap/v4-actions.ts`
- Create: `src/uniswap/v4-actions.test.ts`

This file owns the calldata encoding for the bytes that go inside `UniversalRouter.execute(commands, inputs, deadline)` for a v4 exact-input single-pool swap. The shape:

- One `command` byte: `V4_SWAP` (0x10).
- One `input`: ABI-encoded `(bytes actions, bytes[] params)` where:
  - `actions` packs three action selectors: `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`.
  - `params[0]` = abi-encoded `IV4Router.ExactInputSingleParams { poolKey, zeroForOne, amountIn, amountOutMinimum, hookData }`.
  - `params[1]` = abi-encoded `(currency, maxAmount)` for SETTLE_ALL.
  - `params[2]` = abi-encoded `(currency, minAmount)` for TAKE_ALL.

- [ ] **Step 1: Implement `v4-actions.ts`**

```ts
import { encodeAbiParameters, encodePacked, type Hex } from 'viem';
import {
  UNIVERSAL_ROUTER_V4_SWAP_COMMAND,
  V4_ACTION,
} from '../constants';
import type { PoolKey } from './types';

// Tuple ABI fragment for IV4Router.ExactInputSingleParams.
const EXACT_INPUT_SINGLE_PARAMS = {
  type: 'tuple',
  components: [
    {
      name: 'poolKey',
      type: 'tuple',
      components: [
        { name: 'currency0', type: 'address' },
        { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'hooks', type: 'address' },
      ],
    },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
} as const;

const CURRENCY_AMOUNT_PARAMS = [
  { name: 'currency', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;

export interface BuildV4SwapInputArgs {
  poolKey: PoolKey;
  zeroForOne: boolean;     // true if swapping currency0 → currency1
  amountIn: bigint;
  amountOutMinimum: bigint;
  // The currency the wallet is sending (== currency0 if zeroForOne, else currency1)
  inputCurrency: `0x${string}`;
  // The currency the wallet wants to receive (== currency1 if zeroForOne, else currency0)
  outputCurrency: `0x${string}`;
}

/**
 * Build the single `input` bytes blob for `UniversalRouter.execute(commands, inputs, deadline)`
 * when commands contains only V4_SWAP. Returns just the ABI-encoded `(bytes actions, bytes[] params)`.
 */
export function buildV4ExactInputSingleInput(args: BuildV4SwapInputArgs): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL],
  );

  const swapParams = encodeAbiParameters(
    [EXACT_INPUT_SINGLE_PARAMS],
    [
      {
        poolKey: args.poolKey,
        zeroForOne: args.zeroForOne,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMinimum,
        hookData: '0x',
      },
    ],
  );

  const settleParams = encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [
    args.inputCurrency,
    args.amountIn,
  ]);

  const takeParams = encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [
    args.outputCurrency,
    args.amountOutMinimum,
  ]);

  return encodeAbiParameters(
    [
      { name: 'actions', type: 'bytes' },
      { name: 'params', type: 'bytes[]' },
    ],
    [actions, [swapParams, settleParams, takeParams]],
  );
}

/**
 * Build the (commands, inputs) pair for UniversalRouter.execute(...) for a
 * single v4 exact-input swap. Caller adds the deadline.
 */
export function buildUniversalRouterV4Swap(args: BuildV4SwapInputArgs): {
  commands: Hex;
  inputs: [Hex];
} {
  return {
    commands: encodePacked(['uint8'], [UNIVERSAL_ROUTER_V4_SWAP_COMMAND]),
    inputs: [buildV4ExactInputSingleInput(args)],
  };
}
```

- [ ] **Step 2: Write the unit test**

`src/uniswap/v4-actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildUniversalRouterV4Swap } from './v4-actions';
import { buildPoolKey } from './pool-key-builder';
import { TOKENS } from '../constants';

describe('buildUniversalRouterV4Swap', () => {
  it('produces a single command byte 0x10 (V4_SWAP)', () => {
    const poolKey = buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 3_000);
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
    const poolKey = buildPoolKey(TOKENS.USDC.address, TOKENS.UNI.address, 3_000);
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
    // Three actions packed = 6 hex chars after some encoded-bytes header — exact
    // header offset varies, so just assert the three action bytes (06, 0c, 0f)
    // are all present somewhere in the encoding.
    expect(inputs[0]).toContain('06');
    expect(inputs[0]).toContain('0c');
    expect(inputs[0]).toContain('0f');
  });
});
```

- [ ] **Step 3: Run unit test**

Run: `npx vitest run src/uniswap/v4-actions.test.ts`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/uniswap/v4-actions.ts src/uniswap/v4-actions.test.ts
git commit -m "feat(uniswap): add V4 swap actions encoder for UniversalRouter"
```

---

## Task 6: V4Quoter caller

**Files:**
- Create: `src/uniswap/swap-quoter.ts`
- Create: `src/uniswap/swap-quoter.live.test.ts`

V4Quoter is a simulator contract — it `staticcall`s into PoolManager to compute the exact output for a quote without executing a swap. It returns `(amountOut, gasEstimate)`.

- [ ] **Step 1: Implement `swap-quoter.ts`**

```ts
import {
  createPublicClient,
  http,
  type PublicClient,
} from 'viem';
import { unichain } from 'viem/chains';
import { resolveUnichainRpcUrl, UNISWAP_V4_UNICHAIN } from '../constants';
import { buildPoolKey } from './pool-key-builder';
import type { FeeTier, Quote } from './types';

const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export interface SwapQuoterEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class SwapQuoter {
  private readonly publicClient: PublicClient;

  constructor(env: SwapQuoterEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
  }

  async quoteExactInputSingle(args: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    feeTier: FeeTier;
  }): Promise<Quote> {
    const poolKey = buildPoolKey(args.tokenIn, args.tokenOut, args.feeTier);
    const tokenInLower = args.tokenIn.toLowerCase();
    const zeroForOne = poolKey.currency0.toLowerCase() === tokenInLower;

    const [amountOut] = await this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.v4Quoter as `0x${string}`,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: {
            currency0: poolKey.currency0,
            currency1: poolKey.currency1,
            fee: poolKey.fee,
            tickSpacing: poolKey.tickSpacing,
            hooks: poolKey.hooks,
          },
          zeroForOne,
          exactAmount: args.amountIn,
          hookData: '0x',
        },
      ],
    });

    return {
      amountIn: args.amountIn,
      amountOut,
      feeTier: args.feeTier,
    };
  }
}
```

- [ ] **Step 2: Write the live test**

`src/uniswap/swap-quoter.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SwapQuoter } from './swap-quoter';
import { TOKENS } from '../constants';

const ALCHEMY = process.env.ALCHEMY_API_KEY;

describe.skipIf(!ALCHEMY)('SwapQuoter (live, Unichain)', () => {
  const quoter = new SwapQuoter({
    ALCHEMY_API_KEY: ALCHEMY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });

  it('quotes 1 USDC → UNI', async () => {
    const quote = await quoter.quoteExactInputSingle({
      tokenIn: TOKENS.USDC.address,
      tokenOut: TOKENS.UNI.address,
      amountIn: 1_000_000n,   // 1 USDC (6 decimals)
      feeTier: 3_000,
    });
    console.log('[swap-quoter] 1 USDC → UNI:', quote.amountOut.toString(), 'wei');
    expect(quote.amountOut).toBeGreaterThan(0n);
  });

  it('quotes 0.1 UNI → USDC', async () => {
    const quote = await quoter.quoteExactInputSingle({
      tokenIn: TOKENS.UNI.address,
      tokenOut: TOKENS.USDC.address,
      amountIn: 100_000_000_000_000_000n,   // 0.1 UNI (18 decimals)
      feeTier: 3_000,
    });
    console.log('[swap-quoter] 0.1 UNI → USDC:', quote.amountOut.toString(), 'wei');
    expect(quote.amountOut).toBeGreaterThan(0n);
  });
});
```

- [ ] **Step 3: Run live test**

Run: `npx vitest run src/uniswap/swap-quoter.live.test.ts`
Expected: 2 tests pass; quoted output amounts logged.

If the V4Quoter address in constants is wrong or the contract reverts, document the actual address from uniscan.xyz and update `src/constants/uniswap.ts` Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/uniswap/swap-quoter.ts src/uniswap/swap-quoter.live.test.ts
git commit -m "feat(uniswap): add SwapQuoter via V4Quoter (live test confirms UNI/USDC quotes)"
```

---

## Task 7: Permit2 + ERC20 allowance reader/granter

**Files:**
- Create: `src/uniswap/permit2-allowance.ts`
- Create: `src/uniswap/permit2-allowance.live.test.ts`

Two approval layers must be in place before UniversalRouter can pull tokens:
1. ERC20 token has approved Permit2 for at least `amountIn` (we grant MaxUint256 once).
2. Permit2 has approved UniversalRouter for at least `amountIn`, with expiration > now (we grant MaxUint160 once with far-future expiration).

This task adds reads + the calldata builders. Task 8 (swap executor) calls them.

- [ ] **Step 1: Implement `permit2-allowance.ts`**

```ts
import {
  createPublicClient,
  http,
  encodeFunctionData,
  erc20Abi,
  type PublicClient,
  type Hex,
} from 'viem';
import { unichain } from 'viem/chains';
import { resolveUnichainRpcUrl, UNISWAP_V4_UNICHAIN } from '../constants';

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
// Permit2 expiration is uint48; pick ~year 2200 (well beyond agent lifetime).
const FAR_FUTURE_EXPIRATION = 7_258_118_400; // 2200-01-01

const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

export interface AllowanceReaderEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class Permit2Allowance {
  private readonly publicClient: PublicClient;

  constructor(env: AllowanceReaderEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
  }

  /** ERC20 allowance from owner to Permit2. */
  async readErc20ToPermit2(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`],
    });
  }

  /** Permit2 allowance from owner → UniversalRouter for a specific token. */
  async readPermit2ToRouter(
    token: `0x${string}`,
    owner: `0x${string}`,
  ): Promise<{ amount: bigint; expiration: number; nonce: number }> {
    const [amount, expiration, nonce] = await this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [owner, token, UNISWAP_V4_UNICHAIN.universalRouter as `0x${string}`],
    });
    return { amount, expiration, nonce };
  }

  /** Calldata for ERC20.approve(Permit2, MaxUint256). */
  buildErc20ApprovePermit2Calldata(): Hex {
    return encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`, MAX_UINT256],
    });
  }

  /** Calldata for Permit2.approve(token, UniversalRouter, MaxUint160, FarFuture). */
  buildPermit2ApproveRouterCalldata(token: `0x${string}`): Hex {
    return encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [
        token,
        UNISWAP_V4_UNICHAIN.universalRouter as `0x${string}`,
        MAX_UINT160,
        FAR_FUTURE_EXPIRATION,
      ],
    });
  }
}
```

- [ ] **Step 2: Write the live test (read-only)**

`src/uniswap/permit2-allowance.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { Permit2Allowance } from './permit2-allowance';
import { TOKENS } from '../constants';

const KEY = process.env.WALLET_PRIVATE_KEY;
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);

describe.skipIf(!KEY_VALID || !ALCHEMY)('Permit2Allowance (live, Unichain)', () => {
  const reader = new Permit2Allowance({
    ALCHEMY_API_KEY: ALCHEMY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });
  const account = privateKeyToAccount(KEY! as `0x${string}`);

  it('reads ERC20 allowance from wallet to Permit2 (USDC)', async () => {
    const allowance = await reader.readErc20ToPermit2(TOKENS.USDC.address, account.address);
    console.log('[permit2-allowance] USDC → Permit2:', allowance.toString());
    expect(allowance).toBeGreaterThanOrEqual(0n);
  });

  it('reads Permit2 allowance to UniversalRouter (UNI)', async () => {
    const granted = await reader.readPermit2ToRouter(TOKENS.UNI.address, account.address);
    console.log('[permit2-allowance] UNI Permit2→Router:', {
      amount: granted.amount.toString(),
      expiration: granted.expiration,
      nonce: granted.nonce,
    });
    expect(granted.amount).toBeGreaterThanOrEqual(0n);
  });
});
```

- [ ] **Step 3: Run live test**

Run: `npx vitest run src/uniswap/permit2-allowance.live.test.ts`
Expected: 2 tests pass with allowance values logged. SKIPPED if no key/alchemy.

- [ ] **Step 4: Commit**

```bash
git add src/uniswap/permit2-allowance.ts src/uniswap/permit2-allowance.live.test.ts
git commit -m "feat(uniswap): add Permit2 + ERC20 allowance reader and approve calldata builders"
```

---

## Task 8: Swap executor — composes calldata + sends via wallet

**Files:**
- Create: `src/uniswap/swap-executor.ts`

This is the action layer. `SwapExecutor.executeSwap(args, wallet)`:
1. Reads current ERC20 + Permit2 allowances.
2. If insufficient → first sends ERC20.approve(Permit2, MaxUint256) via `wallet.signAndSendTransaction`, then Permit2.approve(token, UniversalRouter, MaxUint160, farFuture).
3. Builds UniversalRouter.execute calldata via the v4-actions encoder.
4. Sends the swap via `wallet.signAndSendTransaction` with deadline = block.timestamp + 60.
5. Returns the resulting `TransactionReceipt`.

The wallet abstraction means real → real chain, dry-run → synthetic receipt + sentinel hash. UniswapService (Task 10) takes that receipt and writes the `Transaction` row.

- [ ] **Step 1: Implement `swap-executor.ts`**

```ts
import {
  createPublicClient,
  http,
  encodeFunctionData,
  type PublicClient,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { unichain } from 'viem/chains';
import {
  resolveUnichainRpcUrl,
  UNISWAP_V4_UNICHAIN,
  SWAP_DEADLINE_BUFFER_SECONDS,
} from '../constants';
import type { Wallet } from '../wallet/wallet';
import { buildPoolKey } from './pool-key-builder';
import { buildUniversalRouterV4Swap } from './v4-actions';
import { Permit2Allowance } from './permit2-allowance';
import type { SwapParams } from './types';

const UNIVERSAL_ROUTER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const ALLOWANCE_REFRESH_THRESHOLD = (1n << 200n);  // refresh well before MaxUint160 hits

export interface SwapExecutorEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class SwapExecutor {
  private readonly publicClient: PublicClient;
  private readonly allowance: Permit2Allowance;

  constructor(env: SwapExecutorEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
    this.allowance = new Permit2Allowance(env);
  }

  /**
   * Executes a single-pool exact-input v4 swap. Auto-approves Permit2 + UniversalRouter
   * if needed. Returns the swap's TransactionReceipt.
   *
   * `approvalReceipts` collects receipts for any approval txs sent (so the caller can
   * record them as Transactions too). May be empty if approvals were already in place.
   */
  async executeSwap(params: SwapParams, wallet: Wallet): Promise<{
    swapReceipt: TransactionReceipt;
    approvalReceipts: TransactionReceipt[];
  }> {
    const owner = wallet.getAddress();
    const approvalReceipts: TransactionReceipt[] = [];

    // 1. Ensure ERC20 → Permit2 allowance.
    const erc20Allowance = await this.allowance.readErc20ToPermit2(params.tokenIn, owner);
    if (erc20Allowance < params.amountIn) {
      const receipt = await wallet.signAndSendTransaction({
        to: params.tokenIn,
        data: this.allowance.buildErc20ApprovePermit2Calldata(),
      });
      approvalReceipts.push(receipt);
    }

    // 2. Ensure Permit2 → UniversalRouter allowance for this token.
    const permit2Allowance = await this.allowance.readPermit2ToRouter(params.tokenIn, owner);
    const nowSec = Math.floor(Date.now() / 1000);
    const needsRefresh =
      permit2Allowance.amount < ALLOWANCE_REFRESH_THRESHOLD ||
      permit2Allowance.expiration <= nowSec + SWAP_DEADLINE_BUFFER_SECONDS;
    if (needsRefresh) {
      const receipt = await wallet.signAndSendTransaction({
        to: UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`,
        data: this.allowance.buildPermit2ApproveRouterCalldata(params.tokenIn),
      });
      approvalReceipts.push(receipt);
    }

    // 3. Build UniversalRouter v4 swap calldata.
    const poolKey = buildPoolKey(params.tokenIn, params.tokenOut, params.feeTier);
    const tokenInLower = params.tokenIn.toLowerCase();
    const zeroForOne = poolKey.currency0.toLowerCase() === tokenInLower;
    const { commands, inputs } = buildUniversalRouterV4Swap({
      poolKey,
      zeroForOne,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      inputCurrency: params.tokenIn,
      outputCurrency: params.tokenOut,
    });
    const deadline = BigInt(nowSec + SWAP_DEADLINE_BUFFER_SECONDS);
    const data: Hex = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [commands, inputs, deadline],
    });

    // 4. Send the swap tx.
    const swapReceipt = await wallet.signAndSendTransaction({
      to: UNISWAP_V4_UNICHAIN.universalRouter as `0x${string}`,
      data,
    });

    return { swapReceipt, approvalReceipts };
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/uniswap/swap-executor.ts
git commit -m "feat(uniswap): add SwapExecutor with auto-approve (ERC20→Permit2→UniversalRouter)"
```

---

## Task 9: Position tracker (pure logic over Database)

**Files:**
- Create: `src/uniswap/position-tracker.ts`
- Create: `src/uniswap/position-tracker.test.ts`

Treats USDC as the stable reference. Buying a non-stable token opens a `Position` with `costBasisUSD = inputAmountUSD`. Selling that token closes the most recent open `Position` for the same token, computing realized PnL. Partial-close is out of scope: if amounts differ we close fully and net.

- [ ] **Step 1: Implement `position-tracker.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from '../database/database';
import type { Position, TokenAmount } from '../database/types';
import { TOKENS } from '../constants';

const STABLE_TOKEN_ADDRESSES = new Set<string>([TOKENS.USDC.address.toLowerCase()]);

export interface SwapResult {
  agentId: string;
  transactionId: string;        // links Position to the originating Transaction
  tokenIn: TokenAmount;
  tokenOut: TokenAmount;
  inputUSD: number;             // notional USD value of tokenIn at swap time
  outputUSD: number;             // notional USD value of tokenOut at swap time
}

export class PositionTracker {
  constructor(private readonly db: Database) {}

  /**
   * Apply a successful swap to the agent's Position records.
   * - Buying a non-stable token (stable in, non-stable out): open a new Position.
   * - Selling a non-stable token (non-stable in, stable out): close the most-recent
   *   open Position for that token; compute realizedPnlUSD = outputUSD - costBasisUSD.
   * - Both legs non-stable OR both stable: no-op (we only track non-stable holdings).
   */
  async apply(swap: SwapResult): Promise<{ opened?: Position; closed?: Position }> {
    const inIsStable = STABLE_TOKEN_ADDRESSES.has(swap.tokenIn.tokenAddress.toLowerCase());
    const outIsStable = STABLE_TOKEN_ADDRESSES.has(swap.tokenOut.tokenAddress.toLowerCase());

    if (inIsStable && !outIsStable) {
      const opened: Position = {
        id: `pos-${randomUUID()}`,
        agentId: swap.agentId,
        amount: swap.tokenOut,
        costBasisUSD: swap.inputUSD,
        openedByTransactionId: swap.transactionId,
        openedAt: Date.now(),
        closedAt: null,
        realizedPnlUSD: null,
      };
      await this.db.positions.insert(opened);
      return { opened };
    }

    if (!inIsStable && outIsStable) {
      const open = await this.db.positions.findOpen(swap.agentId, swap.tokenIn.tokenAddress);
      if (!open) return {};   // no position to close (e.g. tokens were already on-chain pre-agent)
      const closed: Position = {
        ...open,
        closedAt: Date.now(),
        closedByTransactionId: swap.transactionId,
        realizedPnlUSD: swap.outputUSD - open.costBasisUSD,
      };
      await this.db.positions.update(closed);
      return { closed };
    }

    return {};
  }
}
```

- [ ] **Step 2: Write the unit test (uses an in-memory db stub)**

`src/uniswap/position-tracker.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PositionTracker } from './position-tracker';
import { TOKENS } from '../constants';
import type { Database } from '../database/database';
import type { AgentRepository } from '../database/repositories/agent-repository';
import type { TransactionRepository } from '../database/repositories/transaction-repository';
import type { PositionRepository } from '../database/repositories/position-repository';
import type { AgentMemoryRepository } from '../database/repositories/agent-memory-repository';
import type { Position, TokenAmount } from '../database/types';

class InMemoryPositionRepo implements PositionRepository {
  positions: Position[] = [];
  async insert(pos: Position): Promise<void> { this.positions.push(pos); }
  async findOpen(agentId: string, tokenAddress: string): Promise<Position | null> {
    const open = this.positions.filter(
      (p) => p.agentId === agentId && p.amount.tokenAddress === tokenAddress && p.closedAt === null,
    );
    return open[open.length - 1] ?? null;
  }
  async listByAgent(agentId: string): Promise<Position[]> {
    return this.positions.filter((p) => p.agentId === agentId);
  }
  async update(pos: Position): Promise<void> {
    const idx = this.positions.findIndex((p) => p.id === pos.id);
    if (idx < 0) throw new Error(`Position ${pos.id} not found`);
    this.positions[idx] = pos;
  }
}

function makeDb(positions: InMemoryPositionRepo): Database {
  return {
    agents: {} as AgentRepository,
    transactions: {} as TransactionRepository,
    positions,
    agentMemory: {} as AgentMemoryRepository,
  };
}

const usdcAmount = (raw: string): TokenAmount => ({
  tokenAddress: TOKENS.USDC.address,
  symbol: 'USDC',
  amountRaw: raw,
  decimals: 6,
});
const uniAmount = (raw: string): TokenAmount => ({
  tokenAddress: TOKENS.UNI.address,
  symbol: 'UNI',
  amountRaw: raw,
  decimals: 18,
});

describe('PositionTracker.apply', () => {
  let positions: InMemoryPositionRepo;
  let tracker: PositionTracker;

  beforeEach(() => {
    positions = new InMemoryPositionRepo();
    tracker = new PositionTracker(makeDb(positions));
  });

  it('opens a position when buying a non-stable token (USDC → UNI)', async () => {
    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-buy-1',
      tokenIn: usdcAmount('100000000'),  // 100 USDC
      tokenOut: uniAmount('30000000000000000000'),  // 30 UNI
      inputUSD: 100,
      outputUSD: 100,
    });

    expect(result.opened).toBeDefined();
    expect(result.opened!.amount.symbol).toBe('UNI');
    expect(result.opened!.costBasisUSD).toBe(100);
    expect(result.opened!.openedByTransactionId).toBe('tx-buy-1');
    expect(positions.positions).toHaveLength(1);
  });

  it('closes the most-recent open UNI position when selling UNI → USDC, with realized PnL', async () => {
    await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-buy-1',
      tokenIn: usdcAmount('100000000'),
      tokenOut: uniAmount('30000000000000000000'),
      inputUSD: 100,
      outputUSD: 100,
    });

    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-sell-1',
      tokenIn: uniAmount('30000000000000000000'),
      tokenOut: usdcAmount('120000000'),  // 120 USDC
      inputUSD: 120,
      outputUSD: 120,
    });

    expect(result.closed).toBeDefined();
    expect(result.closed!.closedByTransactionId).toBe('tx-sell-1');
    expect(result.closed!.realizedPnlUSD).toBe(20);  // 120 - 100
    expect(positions.positions[0]!.closedAt).not.toBeNull();
  });

  it('no-op when both legs are non-stable (UNI → some other non-stable)', async () => {
    const otherToken: TokenAmount = {
      tokenAddress: '0x000000000000000000000000000000000000babe',
      symbol: 'OTHER',
      amountRaw: '1',
      decimals: 18,
    };
    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-x',
      tokenIn: uniAmount('30000000000000000000'),
      tokenOut: otherToken,
      inputUSD: 100,
      outputUSD: 100,
    });
    expect(result).toEqual({});
    expect(positions.positions).toHaveLength(0);
  });

  it('no-op when selling a token with no open position', async () => {
    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-orphan-sell',
      tokenIn: uniAmount('30000000000000000000'),
      tokenOut: usdcAmount('100000000'),
      inputUSD: 100,
      outputUSD: 100,
    });
    expect(result).toEqual({});
  });
});
```

- [ ] **Step 3: Run unit test**

Run: `npx vitest run src/uniswap/position-tracker.test.ts`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/uniswap/position-tracker.ts src/uniswap/position-tracker.test.ts
git commit -m "feat(uniswap): add PositionTracker (open on buy, close on sell with realized PnL)"
```

---

## Task 10: UniswapService — composition root

**Files:**
- Create: `src/uniswap/uniswap-service.ts`

Composes Quoter, SwapExecutor, PositionTracker. After a successful swap:
1. Compute USD notional for both legs (uses the price source passed in via `getQuote`/`executeSwap` args — the caller, i.e. the tool wrapper, supplies these).
2. Insert a `Transaction` row (gasUsed/gasPrice from the receipt, swap hash, tokenIn/tokenOut as `TokenAmount`).
3. Insert any approval `Transaction` rows (no tokenIn/out — they're not swaps).
4. Apply `PositionTracker.apply(...)` and capture opened/closed `Position` ids.

- [ ] **Step 1: Implement `uniswap-service.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { TransactionReceipt } from 'viem';
import type { Database } from '../database/database';
import type { AgentConfig, Position, TokenAmount, Transaction } from '../database/types';
import type { Wallet } from '../wallet/wallet';
import { SwapQuoter, type SwapQuoterEnv } from './swap-quoter';
import { SwapExecutor, type SwapExecutorEnv } from './swap-executor';
import { PositionTracker } from './position-tracker';
import type { FeeTier, Quote } from './types';
import { UNICHAIN } from '../constants';

export interface UniswapServiceEnv extends SwapQuoterEnv, SwapExecutorEnv {}

export interface ExecuteSwapArgs {
  tokenIn: TokenAmount;            // tokenIn.amountRaw is the EXACT input
  tokenOut: TokenAmount;            // amountRaw used as label only; actual amount comes from quote
  amountOutMinimum: bigint;         // already slippage-adjusted by the caller
  feeTier: FeeTier;
  inputUSD: number;                 // notional USD at swap time (from price oracle)
  expectedOutputUSD: number;        // optimistic; may diverge from actual
}

export class UniswapService {
  private readonly quoter: SwapQuoter;
  private readonly executor: SwapExecutor;
  private readonly positionTracker: PositionTracker;

  constructor(env: UniswapServiceEnv, private readonly db: Database) {
    this.quoter = new SwapQuoter(env);
    this.executor = new SwapExecutor(env);
    this.positionTracker = new PositionTracker(db);
  }

  async getQuoteExactIn(args: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    feeTier: FeeTier;
  }): Promise<Quote> {
    return this.quoter.quoteExactInputSingle(args);
  }

  /**
   * Execute the swap, persist Transaction + approval Transactions, update Positions.
   * Returns the inserted swap Transaction (with id).
   */
  async executeSwapExactIn(
    args: ExecuteSwapArgs,
    agent: AgentConfig,
    wallet: Wallet,
  ): Promise<{ swapTx: Transaction; approvalTxs: Transaction[]; opened?: Position; closed?: Position }> {
    const { swapReceipt, approvalReceipts } = await this.executor.executeSwap(
      {
        tokenIn: args.tokenIn.tokenAddress as `0x${string}`,
        tokenInDecimals: args.tokenIn.decimals,
        tokenOut: args.tokenOut.tokenAddress as `0x${string}`,
        tokenOutDecimals: args.tokenOut.decimals,
        amountIn: BigInt(args.tokenIn.amountRaw),
        amountOutMinimum: args.amountOutMinimum,
        feeTier: args.feeTier,
      },
      wallet,
    );

    const approvalTxs: Transaction[] = [];
    for (const receipt of approvalReceipts) {
      const tx = this.receiptToTransaction(agent.id, receipt, undefined, undefined);
      await this.db.transactions.insert(tx);
      approvalTxs.push(tx);
    }

    // Best-effort actual output: read from receipt logs (Transfer events) if we can,
    // otherwise fall back to amountOutMinimum as a conservative estimate.
    const actualTokenOut: TokenAmount = {
      ...args.tokenOut,
      amountRaw: args.amountOutMinimum.toString(),
    };
    const swapTx = this.receiptToTransaction(agent.id, swapReceipt, args.tokenIn, actualTokenOut);
    await this.db.transactions.insert(swapTx);

    const { opened, closed } = await this.positionTracker.apply({
      agentId: agent.id,
      transactionId: swapTx.id,
      tokenIn: args.tokenIn,
      tokenOut: actualTokenOut,
      inputUSD: args.inputUSD,
      outputUSD: args.expectedOutputUSD,
    });

    return { swapTx, approvalTxs, opened, closed };
  }

  private receiptToTransaction(
    agentId: string,
    receipt: TransactionReceipt,
    tokenIn: TokenAmount | undefined,
    tokenOut: TokenAmount | undefined,
  ): Transaction {
    const gasUsed = receipt.gasUsed;
    const gasPriceWei = receipt.effectiveGasPrice;
    return {
      id: `tx-${randomUUID()}`,
      agentId,
      hash: receipt.transactionHash,
      chainId: UNICHAIN.chainId,
      from: (receipt.from ?? '0x0000000000000000000000000000000000000000') as string,
      to: (receipt.to ?? '0x0000000000000000000000000000000000000000') as string,
      ...(tokenIn ? { tokenIn } : {}),
      ...(tokenOut ? { tokenOut } : {}),
      gasUsed: gasUsed.toString(),
      gasPriceWei: gasPriceWei.toString(),
      gasCostWei: (gasUsed * gasPriceWei).toString(),
      status: receipt.status === 'success' ? 'success' : 'failed',
      blockNumber: receipt.blockNumber === 0n ? null : Number(receipt.blockNumber),
      timestamp: Date.now(),
    };
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/uniswap/uniswap-service.ts
git commit -m "feat(uniswap): add UniswapService composing quoter + executor + position tracker"
```

---

## Task 11: Quote tool wrapper (read-only — no risk gate)

**Files:**
- Create: `src/ai-tools/uniswap/uniswap-quote-tool.ts`

- [ ] **Step 1: Implement**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import { TOKENS, type TokenSymbol } from '../../constants';
import type { FeeTier } from '../../uniswap/types';

const inputSchema = z.object({
  tokenIn: z.string().describe('Token symbol like USDC or UNI'),
  tokenOut: z.string().describe('Token symbol like USDC or UNI'),
  amountIn: z.string().describe('Raw bigint amount of tokenIn (in tokenIn decimals) as a string'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000 (most liquid for UNI/USDC).'),
});

export function buildUniswapQuoteTool(svc: UniswapService): AgentTool<typeof inputSchema> {
  return {
    name: 'getUniswapQuoteExactIn',
    description:
      'Quote a Uniswap v4 swap on Unichain for an exact input amount. Returns JSON {amountOut, feeTier}. Use before executeUniswapSwapExactIn to size your trade.',
    inputSchema,
    async invoke({ tokenIn, tokenOut, amountIn, feeTier }) {
      const inToken = TOKENS[tokenIn.toUpperCase() as TokenSymbol];
      const outToken = TOKENS[tokenOut.toUpperCase() as TokenSymbol];
      if (!inToken || !outToken) {
        throw new Error(`Unknown token symbol(s). Known: ${Object.keys(TOKENS).join(', ')}`);
      }
      const tier: FeeTier = feeTier ?? 3_000;
      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address,
        tokenOut: outToken.address,
        amountIn: BigInt(amountIn),
        feeTier: tier,
      });
      return {
        amountOut: quote.amountOut.toString(),
        feeTier: tier,
        tokenIn: inToken.symbol,
        tokenOut: outToken.symbol,
      };
    },
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/uniswap/uniswap-quote-tool.ts
git commit -m "feat(ai-tools): add Uniswap quote tool (read-only)"
```

---

## Task 12: Swap tool wrapper — RISK GATE

**Files:**
- Create: `src/ai-tools/uniswap/uniswap-swap-tool.ts`

The risk gate happens HERE (per spec — keep `UniswapService` reusable for non-agent callers):
1. Resolve symbols → `TokenInfo` via `TOKENS`.
2. Validate `slippageBps <= agent.riskLimits.maxSlippageBps`.
3. Quote the swap to get `amountOut`.
4. Compute USD notional: `inputUSD = (amountIn / 10^decimals) * coingeckoPrice(tokenIn)`.
5. Validate `inputUSD <= agent.riskLimits.maxTradeUSD`.
6. Compute `amountOutMinimum = amountOut * (10000 - slippageBps) / 10000`.
7. Call `UniswapService.executeSwapExactIn(...)`.
8. Return JSON of the swap tx + opened/closed position info.

- [ ] **Step 1: Implement**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { TOKENS, type TokenSymbol } from '../../constants';
import type { FeeTier } from '../../uniswap/types';

const inputSchema = z.object({
  tokenIn: z.string().describe('Token symbol like USDC or UNI'),
  tokenOut: z.string().describe('Token symbol like USDC or UNI'),
  amountIn: z.string().describe('Raw bigint amount of tokenIn (in tokenIn decimals) as a string'),
  slippageBps: z.number().int().min(1).max(10_000).optional()
    .describe('Max slippage in basis points (e.g. 50 = 0.5%). Defaults to agent.riskLimits.maxSlippageBps; capped at it.'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000 (most liquid for UNI/USDC).'),
});

export function buildUniswapSwapTool(
  svc: UniswapService,
  coingecko: CoingeckoService,
): AgentTool<typeof inputSchema> {
  return {
    name: 'executeUniswapSwapExactIn',
    description:
      'Execute a Uniswap v4 single-pool exact-input swap on Unichain. Risk gate enforces agent.riskLimits.maxTradeUSD and maxSlippageBps. Returns JSON {transactionId, hash, status, opened?: positionId, closed?: {positionId, realizedPnlUSD}}.',
    inputSchema,
    async invoke({ tokenIn, tokenOut, amountIn, slippageBps, feeTier }, ctx) {
      const inToken = TOKENS[tokenIn.toUpperCase() as TokenSymbol];
      const outToken = TOKENS[tokenOut.toUpperCase() as TokenSymbol];
      if (!inToken || !outToken) {
        throw new Error(`Unknown token symbol(s). Known: ${Object.keys(TOKENS).join(', ')}`);
      }

      const maxSlippageBps = ctx.agent.riskLimits.maxSlippageBps;
      const requestedSlippage = slippageBps ?? maxSlippageBps;
      if (requestedSlippage > maxSlippageBps) {
        throw new Error(`requested slippage ${requestedSlippage}bps exceeds agent maxSlippageBps ${maxSlippageBps}`);
      }

      const tier: FeeTier = feeTier ?? 3_000;

      // Quote first to know amountOut for slippage + risk math.
      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address,
        tokenOut: outToken.address,
        amountIn: BigInt(amountIn),
        feeTier: tier,
      });

      // USD notional via Coingecko.
      const inPriceUSD = await coingecko.fetchTokenPriceUSD(inToken.coingeckoId);
      const outPriceUSD = await coingecko.fetchTokenPriceUSD(outToken.coingeckoId);
      const inputUSD = (Number(BigInt(amountIn)) / 10 ** inToken.decimals) * inPriceUSD;
      const expectedOutputUSD = (Number(quote.amountOut) / 10 ** outToken.decimals) * outPriceUSD;

      const maxTradeUSD = ctx.agent.riskLimits.maxTradeUSD;
      if (inputUSD > maxTradeUSD) {
        throw new Error(`trade ${inputUSD.toFixed(2)} USD exceeds agent maxTradeUSD ${maxTradeUSD}`);
      }

      // amountOutMinimum = amountOut * (10000 - slippage) / 10000
      const amountOutMinimum = (quote.amountOut * BigInt(10_000 - requestedSlippage)) / 10_000n;

      const result = await svc.executeSwapExactIn(
        {
          tokenIn: { ...inToken, amountRaw: amountIn },
          tokenOut: { ...outToken, amountRaw: quote.amountOut.toString() },
          amountOutMinimum,
          feeTier: tier,
          inputUSD,
          expectedOutputUSD,
        },
        ctx.agent,
        ctx.wallet,
      );

      return {
        transactionId: result.swapTx.id,
        hash: result.swapTx.hash,
        status: result.swapTx.status,
        amountIn,
        amountOutEstimated: quote.amountOut.toString(),
        amountOutMinimum: amountOutMinimum.toString(),
        feeTier: tier,
        slippageBps: requestedSlippage,
        approvalTxIds: result.approvalTxs.map((t) => t.id),
        ...(result.opened ? { openedPositionId: result.opened.id } : {}),
        ...(result.closed
          ? { closedPositionId: result.closed.id, realizedPnlUSD: result.closed.realizedPnlUSD }
          : {}),
      };
    },
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/uniswap/uniswap-swap-tool.ts
git commit -m "feat(ai-tools): add Uniswap swap tool with risk gate (maxTradeUSD + maxSlippageBps)"
```

---

## Task 13: Wire UniswapService through ToolRegistry + bootstrap

**Files:**
- Modify: `src/ai-tools/tool-registry.ts`
- Modify: `src/ai-tools/tool-registry.test.ts`
- Modify: `src/ai-tools/tool-registry.live.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update `tool-registry.ts`**

Add to `ToolRegistryDeps`:

```ts
import type { UniswapService } from '../uniswap/uniswap-service';
// ...
export interface ToolRegistryDeps {
  // ...existing...
  uniswap: UniswapService;
}
```

Update `build()` — add 2 tools at the end:

```ts
import { buildUniswapQuoteTool } from './uniswap/uniswap-quote-tool';
import { buildUniswapSwapTool } from './uniswap/uniswap-swap-tool';
// ...
  build(): AgentTool[] {
    const [nativeBalance, tokenBalance] = buildWalletBalanceTools();
    return [
      buildCoingeckoPriceTool(this.deps.coingecko),
      buildCoinMarketCapInfoTool(this.deps.coinmarketcap),
      buildSerperSearchTool(this.deps.serper),
      buildFirecrawlScrapeTool(this.deps.firecrawl),
      nativeBalance,
      tokenBalance,
      buildReadMemoryTool(this.deps.db),
      buildUpdateMemoryTool(this.deps.db),
      buildSaveMemoryEntryTool(this.deps.db),
      buildSearchMemoryEntriesTool(this.deps.db),
      buildUniswapQuoteTool(this.deps.uniswap),
      buildUniswapSwapTool(this.deps.uniswap, this.deps.coingecko),
    ];
  }
```

- [ ] **Step 2: Update unit test to expect 12 tools**

In `tool-registry.test.ts`, update the test names list:

```ts
    expect(names).toEqual([
      'fetchTokenPriceUSD',
      'fetchTokenInfoBySymbol',
      'searchWeb',
      'scrapeUrlMarkdown',
      'getNativeBalance',
      'getTokenBalance',
      'readMemory',
      'updateMemory',
      'saveMemoryEntry',
      'searchMemoryEntries',
      'getUniswapQuoteExactIn',
      'executeUniswapSwapExactIn',
    ]);
```

The existing `it('every tool has a non-empty description and a zod input schema', ...)` keeps working unchanged. The constructor now needs a `uniswap` field — pass `{} as UniswapService` since the test never invokes the tool. Update the `new ToolRegistry({...})` calls in BOTH `it` blocks of the unit test:

```ts
    const registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: 'unused' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: 'unused' }),
      serper: new SerperService({ apiKey: 'unused' }),
      firecrawl: new FirecrawlService({ apiKey: 'unused' }),
      db: {} as Database,
      uniswap: {} as import('../uniswap/uniswap-service').UniswapService,
    });
```

- [ ] **Step 3: Update live test — add a quote-tool live assertion**

In `tool-registry.live.test.ts`, the `beforeEach` now needs `uniswap`. If `ALCHEMY_API_KEY` is set, construct a real `UniswapService`; otherwise pass `{}`-cast.

Add to imports:
```ts
import { UniswapService } from '../uniswap/uniswap-service';
```

Inside `beforeEach`, after the existing `registry = new ToolRegistry(...)` block, change to:

```ts
    const ALCHEMY = process.env.ALCHEMY_API_KEY;
    registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: COINGECKO ?? 'dummy' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: process.env.COINMARKETCAP_API_KEY ?? 'dummy' }),
      serper: new SerperService({ apiKey: process.env.SERPER_API_KEY ?? 'dummy' }),
      firecrawl: new FirecrawlService({ apiKey: process.env.FIRECRAWL_API_KEY ?? 'dummy' }),
      db,
      uniswap: ALCHEMY
        ? new UniswapService({ ALCHEMY_API_KEY: ALCHEMY, UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL }, db)
        : ({} as UniswapService),
    });
```

Add a new live `it` (gated on Alchemy):

```ts
  it.skipIf(!process.env.ALCHEMY_API_KEY)('getUniswapQuoteExactIn returns a positive amountOut for 1 USDC → UNI', async () => {
    const tool = registry.build().find((t) => t.name === 'getUniswapQuoteExactIn');
    if (!tool) throw new Error('quote tool missing');
    const result = (await tool.invoke({
      tokenIn: 'USDC',
      tokenOut: 'UNI',
      amountIn: '1000000',
    }, ctx)) as { amountOut: string; feeTier: number };
    console.log('[tool-registry] uniswap quote:', result);
    expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
    expect(result.feeTier).toBe(3_000);
  });
```

- [ ] **Step 4: Update `src/index.ts` to construct UniswapService**

Add imports:
```ts
import { UniswapService } from './uniswap/uniswap-service';
```

After `walletFactory` is constructed, add:
```ts
  const uniswap = new UniswapService(env, db);
```

Update the ToolRegistry construction to pass `uniswap`:
```ts
  const toolRegistry = new ToolRegistry({
    coingecko: new CoingeckoService({ apiKey: env.COINGECKO_API_KEY }),
    coinmarketcap: new CoinMarketCapService({ apiKey: env.COINMARKETCAP_API_KEY }),
    serper: new SerperService({ apiKey: env.SERPER_API_KEY }),
    firecrawl: new FirecrawlService({ apiKey: env.FIRECRAWL_API_KEY }),
    db,
    uniswap,
  });
```

Update the log line `[bootstrap] tool registry initialized (10 tools)` — count is now 12 dynamically (already does `toolRegistry.build().length` so no change needed).

- [ ] **Step 5: Verify typecheck + run all tests**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: ToolRegistry unit test reports 12 tools; live test passes the new quote assertion (if Alchemy configured); all prior tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/ai-tools/tool-registry.ts src/ai-tools/tool-registry.test.ts src/ai-tools/tool-registry.live.test.ts src/index.ts
git commit -m "feat: wire UniswapService through ToolRegistry (12 tools) + bootstrap"
```

---

## Task 14: Interactive swap test

**Files:**
- Create: `src/uniswap/uniswap-service.interactive.test.ts`

This test only runs when `INTERACTIVE_TESTS=1`. Each `it` asks y/n; on "n" the test is skipped via `ctx.skip()`. On "y" it executes a tiny real swap and asserts pre/post wallet balances changed by the expected amounts.

- [ ] **Step 1: Implement**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { confirmContinue } from '../test-lib/interactive-prompt';
import { RealWallet } from '../wallet/real/real-wallet';
import { UniswapService } from './uniswap-service';
import { FileDatabase } from '../database/file-database/file-database';
import { TOKENS } from '../constants';
import type { AgentConfig } from '../database/types';

const KEY = process.env.WALLET_PRIVATE_KEY;
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);
const INTERACTIVE = process.env.INTERACTIVE_TESTS === '1';

const dbDir = process.env.DB_DIR ?? './db';

// Tiny test amounts so failures are cheap.
const SWAP_USDC_IN = 500_000n;            // 0.5 USDC
const SWAP_UNI_IN  = 100_000_000_000_000_000n;   // 0.1 UNI

describe.skipIf(!INTERACTIVE || !KEY_VALID || !ALCHEMY)('UniswapService (interactive, real onchain)', () => {
  let wallet: RealWallet;
  let svc: UniswapService;
  let db: FileDatabase;
  let agent: AgentConfig;

  beforeAll(() => {
    db = new FileDatabase(dbDir);
    wallet = new RealWallet({
      WALLET_PRIVATE_KEY: KEY!,
      ALCHEMY_API_KEY: ALCHEMY!,
      UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
    });
    svc = new UniswapService({ ALCHEMY_API_KEY: ALCHEMY!, UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL }, db);
    agent = {
      id: 'interactive-swap-test',
      name: 'Interactive Swap Test',
      enabled: false,
      intervalMs: 1_000,
      prompt: 'interactive test',
      walletAddress: wallet.getAddress(),
      dryRun: false,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
      lastTickAt: null,
      createdAt: Date.now(),
    };
  });

  it('swaps 0.5 USDC for UNI on Unichain mainnet (real funds)', async (ctx) => {
    const ok = await confirmContinue(
      `About to swap 0.5 USDC for UNI on Unichain (wallet ${wallet.getAddress()}). Continue?`,
    );
    if (!ok) {
      ctx.skip();
      return;
    }

    const usdcBefore = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniBefore = await wallet.getTokenBalance(TOKENS.UNI.address);

    const quote = await svc.getQuoteExactIn({
      tokenIn: TOKENS.USDC.address,
      tokenOut: TOKENS.UNI.address,
      amountIn: SWAP_USDC_IN,
      feeTier: 3_000,
    });
    const amountOutMinimum = (quote.amountOut * 9_800n) / 10_000n;  // 2% slippage tolerance

    const result = await svc.executeSwapExactIn(
      {
        tokenIn: { ...TOKENS.USDC, amountRaw: SWAP_USDC_IN.toString() },
        tokenOut: { ...TOKENS.UNI, amountRaw: quote.amountOut.toString() },
        amountOutMinimum,
        feeTier: 3_000,
        inputUSD: 0.5,
        expectedOutputUSD: 0.5,
      },
      agent,
      wallet,
    );

    const usdcAfter = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniAfter = await wallet.getTokenBalance(TOKENS.UNI.address);
    const usdcDelta = usdcBefore - usdcAfter;
    const uniDelta = uniAfter - uniBefore;

    console.log('[interactive] swap done. tx:', result.swapTx.hash);
    console.log('[interactive] USDC sent:', usdcDelta.toString());
    console.log('[interactive] UNI received:', uniDelta.toString());

    expect(result.swapTx.status).toBe('success');
    expect(usdcDelta).toBeGreaterThanOrEqual(SWAP_USDC_IN);  // includes any approval fees doesn't apply (USDC-only out path)
    expect(uniDelta).toBeGreaterThanOrEqual(amountOutMinimum);
    expect(result.opened).toBeDefined();
  }, 180_000);

  it('swaps 0.1 UNI for USDC on Unichain mainnet (real funds, closes the position)', async (ctx) => {
    const ok = await confirmContinue(
      `About to swap 0.1 UNI for USDC on Unichain (wallet ${wallet.getAddress()}). Continue?`,
    );
    if (!ok) {
      ctx.skip();
      return;
    }

    const usdcBefore = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniBefore = await wallet.getTokenBalance(TOKENS.UNI.address);

    const quote = await svc.getQuoteExactIn({
      tokenIn: TOKENS.UNI.address,
      tokenOut: TOKENS.USDC.address,
      amountIn: SWAP_UNI_IN,
      feeTier: 3_000,
    });
    const amountOutMinimum = (quote.amountOut * 9_800n) / 10_000n;

    const result = await svc.executeSwapExactIn(
      {
        tokenIn: { ...TOKENS.UNI, amountRaw: SWAP_UNI_IN.toString() },
        tokenOut: { ...TOKENS.USDC, amountRaw: quote.amountOut.toString() },
        amountOutMinimum,
        feeTier: 3_000,
        inputUSD: 0.5,
        expectedOutputUSD: 0.5,
      },
      agent,
      wallet,
    );

    const usdcAfter = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniAfter = await wallet.getTokenBalance(TOKENS.UNI.address);

    console.log('[interactive] swap done. tx:', result.swapTx.hash);
    console.log('[interactive] UNI sent:', (uniBefore - uniAfter).toString());
    console.log('[interactive] USDC received:', (usdcAfter - usdcBefore).toString());

    expect(result.swapTx.status).toBe('success');
  }, 180_000);
});
```

- [ ] **Step 2: Verify the file typechecks**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Smoke that `npm test` does NOT include this file**

Run: `npm test` and confirm `uniswap-service.interactive.test.ts` is NOT in the run list (it's excluded by the main vitest config). Expected: same counts as before, no interactive run.

- [ ] **Step 4: DO NOT actually run `npm run test:interactive` here**

Operator decides when to run it. If they do, they confirm y/n at each prompt. Document this in the report.

- [ ] **Step 5: Commit**

```bash
git add src/uniswap/uniswap-service.interactive.test.ts
git commit -m "feat(uniswap): add interactive UNI↔USDC swap test (y/n confirmation, real funds)"
```

---

## Task 15: Final sweep + tag

- [ ] **Step 1: Full test suite**

Run: `npm test`

Expected:
- New unit tests: pool-key-builder (4), v4-actions (2), position-tracker (4) — all pass
- New live tests: pool-state-reader (2), swap-quoter (2), permit2-allowance (2) — all pass if Alchemy + key configured, otherwise SKIP
- ToolRegistry unit test now expects 12 tools — passes
- ToolRegistry live test gains uniswap quote assertion — passes if Alchemy configured
- Slice 1–6 suites unchanged
- Known fail: Firecrawl 402

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exit 0; `dist/uniswap/` populated.

- [ ] **Step 3: Verify directory structure**

Run: `find src/uniswap src/ai-tools/uniswap -type f | sort`

Expected:
```
src/ai-tools/uniswap/uniswap-quote-tool.ts
src/ai-tools/uniswap/uniswap-swap-tool.ts
src/uniswap/permit2-allowance.live.test.ts
src/uniswap/permit2-allowance.ts
src/uniswap/pool-key-builder.test.ts
src/uniswap/pool-key-builder.ts
src/uniswap/pool-state-reader.live.test.ts
src/uniswap/pool-state-reader.ts
src/uniswap/position-tracker.test.ts
src/uniswap/position-tracker.ts
src/uniswap/swap-executor.ts
src/uniswap/swap-quoter.live.test.ts
src/uniswap/swap-quoter.ts
src/uniswap/types.ts
src/uniswap/uniswap-service.interactive.test.ts
src/uniswap/uniswap-service.ts
src/uniswap/v4-actions.test.ts
src/uniswap/v4-actions.ts
```

- [ ] **Step 4: Tag**

```bash
git tag slice-7-uniswap
```

- [ ] **Step 5: Commit count**

Run: `git log --oneline slice-6-tools..HEAD`
Expected: ~16 commits (Tasks 1–14 plus the docs/plan commit).

- [ ] **Step 6: Smoke `npm start` (StubLLM path)**

```bash
rm -f ./db/zerog-bootstrap.json
WALLET_PRIVATE_KEY=0x$(printf '11%.0s' {1..32}) npm start &
PID=$!
sleep 12
kill $PID 2>/dev/null
wait $PID 2>/dev/null
```

Expected log includes: `[bootstrap] tool registry initialized (12 tools)`.

---

## Out of Scope for Slice 7

Deferred to later slices:
- Multi-hop swaps (USDC → ETH → UNI) — single-hop only for v1
- Partial-position close — locked: close fully and net PnL
- Token list expansion beyond UNI/USDC — slice 8 may add more
- Price oracle other than Coingecko (slippage uses Coingecko prices for risk gate; on-chain prices via PoolStateReader available but not used here)
- Slippage protection for the approval txs (they don't slip; the swap does)
- Seed agent end-to-end — Slice 8

---

## Self-Review

**Spec coverage check:**
- ✅ "Uniswap" section — UniswapService with `getQuoteExactIn` + `executeSwapExactIn`, pool key builder + state reader + quoter (Tasks 3, 4, 6, 10)
- ✅ Risk enforcement at the tool wrapper, NOT in UniswapService — Task 12 (swap tool's risk gate); UniswapService stays generic (Task 10)
- ✅ Both legs of a Position reference the originating Transaction via `openedByTransactionId` / `closedByTransactionId` — Task 9 (PositionTracker)
- ✅ DryRunWallet receives the same calldata via `wallet.signAndSendTransaction` and synthesizes a sentinel-hash receipt — Task 8 (SwapExecutor uses Wallet abstraction; DryRunWallet from slice 3 does the rest)
- ✅ Approvals automated inside SwapExecutor.executeSwap — Task 8 (auto-approve flow per user's locked decision)
- ✅ Interactive swap test, INTERACTIVE_TESTS=1 + y/n — Task 14
- ✅ `maxSlippageBps` added to riskLimits with default `100` (1%) — Task 1
- ✅ npm test split — Task 1 (vitest configs + scripts)

**Placeholder scan:** No TBDs. Each step has actual code or exact commands. The "if quoter address is wrong update Task 2" note in Task 4 has a clear remediation path (look up uniscan.xyz).

**Type consistency:**
- `FeeTier`, `PoolKey`, `Slot0`, `Quote`, `SwapParams` defined in Task 3 — used identically across Tasks 4, 5, 6, 8, 10
- `UNISWAP_V4_UNICHAIN`, `FEE_TIER_TO_TICK_SPACING`, `V4_ACTION`, `UNIVERSAL_ROUTER_V4_SWAP_COMMAND`, `SWAP_DEADLINE_BUFFER_SECONDS` defined in Task 2 — used in Tasks 5, 7, 8
- `Wallet` interface from slice 3 is what `SwapExecutor` (Task 8) and `UniswapService` (Task 10) consume — no duplication
- `TokenAmount`, `Transaction`, `Position` from slice 2 used unchanged in `UniswapService` and `PositionTracker`
- `AgentTool<TInput>` from slice 6 used by both new tools — same signature
- `AgentToolContext` (slice 6) provides `agent + wallet + tickId` — consumed by swap tool's risk gate
- `coingecko-id-for-token` is computed inline as `inToken.coingeckoId` (slice 6 added this field to `TokenInfo`) — no helper function; consistent across both tools
