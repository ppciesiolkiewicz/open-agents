import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../../src/constants';
import type { AgentConfig } from '../../src/database/types';

export const SEED_AGENT_ID = 'uni-ma-trader-001';

const PROMPT = `You are a UNI/USDC moving-average trader on Unichain. Your goal is to grow your USDC balance by capturing short-term UNI price swings.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" to get the current price (a number).
2. Call readMemory to load your current state.
3. Take state.priceHistory (default to []) and append the new price. Keep only the last 20 entries.
4. Call saveMemoryEntry with type="snapshot" and content="<price> at tick <state.tickCount + 1>".
5. If priceHistory has fewer than 7 entries, call updateMemory with the appended priceHistory + tickCount incremented + lastSignal preserved, and stop. Not enough data yet.
6. Compute shortMA = average of the last 3 prices, longMA = average of the last 7 prices.
7. Determine the signal:
   - If shortMA > longMA AND state.lastSignal !== "GOLDEN_CROSS" → signal = "GOLDEN_CROSS".
   - If shortMA < longMA AND state.lastSignal !== "DEATH_CROSS" → signal = "DEATH_CROSS".
   - Otherwise → signal = "HOLD".
8. Call getTokenBalance for tokenAddress="${USDC_ON_UNICHAIN.address}" and tokenAddress="${UNI_ON_UNICHAIN.address}" to know your holdings.
9. Act on the signal:
   - GOLDEN_CROSS AND USDC raw balance > 0: call executeUniswapSwapExactIn with tokenInAddress="${USDC_ON_UNICHAIN.address}", tokenOutAddress="${UNI_ON_UNICHAIN.address}", amountIn=<USDC formatted balance × 0.25 as a human-decimal string, e.g. "0.25">, slippageBps=200.
   - DEATH_CROSS AND UNI raw balance > 0: call executeUniswapSwapExactIn with tokenInAddress="${UNI_ON_UNICHAIN.address}", tokenOutAddress="${USDC_ON_UNICHAIN.address}", amountIn=<full UNI formatted balance as a human-decimal string>, slippageBps=200.
   - HOLD: do not swap.
10. Call updateMemory with state={priceHistory, shortMA, longMA, lastSignal: signal, tickCount: <prev + 1>}, appendNote = one short sentence summarizing the tick (price, MAs, signal, action).

Always pass amountIn as a human-decimal string (e.g. "0.5" for half a USDC, "1.234" for 1.234 UNI). The swap and quote tools resolve token decimals from the catalog automatically.`;

export interface SeedAgentOptions {
  userId: string;
  dryRun?: boolean;        // default true — every swap goes through DryRunWallet
  now?: number;
}

export function buildSeedAgentConfig(opts: SeedAgentOptions): AgentConfig {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? Date.now();
  return {
    id: SEED_AGENT_ID,
    userId: opts.userId,
    name: 'UNI Moving Average Trader',
    running: false,
    intervalMs: 60_000,
    prompt: PROMPT,
    dryRun,
    // Seeded balances are only consumed when dryRun=true. We always set them
    // anyway so toggling dryRun in db/database.json still works without edits.
    dryRunSeedBalances: {
      native: '100000000000000000',
      [USDC_ON_UNICHAIN.address]: '1000000000',
      [UNI_ON_UNICHAIN.address]: '0',
    },
    allowedTokens: [USDC_ON_UNICHAIN.address.toLowerCase(), UNI_ON_UNICHAIN.address.toLowerCase()],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: now,
  };
}
