import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { confirmContinue } from '../src/test-lib/interactive-prompt';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN, WBTC_ON_UNICHAIN } from '../src/constants';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';
import { PrismaUserRepository } from '../src/database/prisma-database/prisma-user-repository';
import type { AgentConfig } from '../src/database/types';

const SEED_USER_EMAIL = 'ppciesiolkiewicz@gmail.com';
const SEED_USER_DID = 'did:privy:cmojphu3700g40cieu3d6zmmc';

const TOKENS = [
  {
    chainId: 130,
    chain: 'unichain',
    address: USDC_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    coingeckoId: USDC_ON_UNICHAIN.coingeckoId,
    logoUri: null,
  },
  {
    chainId: 130,
    chain: 'unichain',
    address: UNI_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    coingeckoId: UNI_ON_UNICHAIN.coingeckoId,
    logoUri: null,
  },
  {
    chainId: 130,
    chain: 'unichain',
    address: WBTC_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    coingeckoId: WBTC_ON_UNICHAIN.coingeckoId,
    logoUri: null,
  },
];

const TOKEN_CONTEXT = `
Token mapping for this simulation:
- UNI (address: ${UNI_ON_UNICHAIN.address}) = milk; 0.000001 UNI = 1L of milk
- USDC (address: ${USDC_ON_UNICHAIN.address}) = money; 0.000001 USDC = $1
- WBTC (address: ${WBTC_ON_UNICHAIN.address}) = cheese; 0.000001 WBTC = 1kg of cheese

AXL messaging:
- Call listAvailableChannels to see which industry channels you are connected to.
- Call sendMessageToChannel with channelId and message to broadcast to all members of that channel (e.g. announce surplus supply, ask for bids, share price intel).
- Messages from other agents arrive as incoming tool results in subsequent ticks via the AXL P2P network.
`.trim();

const MILK_CHANNEL_HINT = `
Industry channel: You are a member of the "Milk Producers" channel.
Each tick, call listAvailableChannels to get the channelId, then call sendMessageToChannel with a JSON message in one of these formats:

SELL_OFFER — announce milk available for sale:
{ "type": "SELL_OFFER", "from": "<your agent name>", "volumeUNI": "0.20", "askPriceUSD": 8.50, "minOrderUNI": "0.05", "note": "optional free text" }

PRICE_REPORT — share market intelligence:
{ "type": "PRICE_REPORT", "from": "<your agent name>", "spotPriceUSD": 8.42, "trend": "rising|falling|stable", "note": "optional free text" }

Always send exactly one message per tick. Pick the type that best describes your current action. Stringify the JSON before passing it as the message parameter.
`.trim();

const CHEESE_CHANNEL_HINT = `
Industry channel: You are a member of the "Cheese Producers" channel.
Each tick, call listAvailableChannels to get the channelId, then call sendMessageToChannel with a JSON message in one of these formats:

MILK_BUY_REQUEST — announce you need milk:
{ "type": "MILK_BUY_REQUEST", "from": "<your agent name>", "volumeUNI": "0.50", "maxPriceUSD": 8.00, "note": "optional free text" }

CHEESE_SELL_OFFER — announce cheese available for sale:
{ "type": "CHEESE_SELL_OFFER", "from": "<your agent name>", "volumeWBTC": "0.0003", "askPriceUSD": 92000, "note": "optional free text" }

MARKET_UPDATE — share general intelligence:
{ "type": "MARKET_UPDATE", "from": "<your agent name>", "milkPriceUSD": 8.42, "cheesePriceUSD": 91500, "note": "optional free text" }

Always send exactly one message per tick. Pick the type that best describes your current state. Stringify the JSON before passing it as the message parameter.
`.trim();

function buildAgents(userId: string): AgentConfig[] {
  const now = Date.now();

  const milkProducerAlpine: AgentConfig = {
    id: 'milk-producer-alpine-001',
    userId,
    name: 'Alpine Milk Co',
    running: false,
    intervalMs: 60_000,
    dryRun: false,
    dryRunSeedBalances: {
      native: '100000000000000000',
      [UNI_ON_UNICHAIN.address.toLowerCase()]: '10000000000000000000', // 10 UNI
      [USDC_ON_UNICHAIN.address.toLowerCase()]: '5000000',             // 5 USDC
    },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 50, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Alpine Milk Co, a small family dairy farm. You sell milk (UNI tokens) to generate revenue (USDC).

${TOKEN_CONTEXT}

${MILK_CHANNEL_HINT}

Your strategy:
- You are patient and price-conscious. Only sell milk when the UNI price meets your floor.
- Sell in small batches (0.1–0.3 UNI) to avoid flooding the market.
- Keep at least 2 UNI in reserve as buffer stock.
- If prices are very good (>$10), you are willing to sell a larger batch as a bonus sale.
- Never hold less than 1 USDC — that's your operating cash.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" to get current milk price.
2. Call getTokenBalance for tokenAddress="${UNI_ON_UNICHAIN.address}" and tokenAddress="${USDC_ON_UNICHAIN.address}".
3. Call readMemory to load your state (default state: { lastSignal: null, tickCount: 0 }).
4. Decide action:
   - If UNI price > 10 AND UNI balance > 2: sell 0.3 UNI → USDC (opportunistic bulk).
   - Else if UNI price > 8 AND UNI balance > 2: sell 0.2 UNI → USDC (standard sale).
   - Otherwise: hold, note market too low or stock too thin.
5. If selling: call executeUniswapSwapExactIn with tokenInAddress="${UNI_ON_UNICHAIN.address}", tokenOutAddress="${USDC_ON_UNICHAIN.address}", amountIn as a human-decimal string (e.g. "0.2"), slippageBps=200.
6. Call updateMemory with state={ tickCount: prev+1, lastAction, lastPrice: current UNI price }, appendNote = one sentence summary.`,
  };

  const milkProducerSunrise: AgentConfig = {
    id: 'milk-producer-sunrise-001',
    userId,
    name: 'Sunrise Dairy',
    running: false,
    intervalMs: 60_000,
    dryRun: false,
    dryRunSeedBalances: {
      native: '100000000000000000',
      [UNI_ON_UNICHAIN.address.toLowerCase()]: '20000000000000000000', // 20 UNI
      [USDC_ON_UNICHAIN.address.toLowerCase()]: '3000000',             // 3 USDC
    },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 200, maxSlippageBps: 300 },
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Sunrise Dairy, a large industrial milk producer. You move volume quickly and don't wait for perfect prices.

${TOKEN_CONTEXT}

${MILK_CHANNEL_HINT}

Your strategy:
- You are a volume seller — sell large amounts even at thin margins.
- Sell whenever UNI price > $6. Don't overthink it.
- If milk prices are very cheap (<$5) and you have spare USDC, buy more milk stock cheaply.
- You have no patience for holding USDC idle — convert it to milk or sell milk constantly.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI".
2. Call getTokenBalance for tokenAddress="${UNI_ON_UNICHAIN.address}" and tokenAddress="${USDC_ON_UNICHAIN.address}".
3. Call readMemory to load state (default: { tickCount: 0 }).
4. Decide action:
   - If UNI price > 6 AND UNI balance > 3: sell 1.5 UNI → USDC.
   - Else if UNI price < 5 AND USDC balance > 5: buy 1 UNI with USDC (restock at discount).
   - Otherwise: hold.
5. Execute swap if action taken: call executeUniswapSwapExactIn with appropriate tokenInAddress, tokenOutAddress, amountIn as human-decimal string, slippageBps=250.
6. Call updateMemory with state={ tickCount: prev+1, lastAction, lastPrice }, appendNote = one sentence summary.`,
  };

  const cheeseProducerArtisan: AgentConfig = {
    id: 'cheese-producer-artisan-001',
    userId,
    name: 'Artisan Cheese House',
    running: false,
    intervalMs: 60_000,
    dryRun: false,
    dryRunSeedBalances: {
      native: '100000000000000000',
      [USDC_ON_UNICHAIN.address.toLowerCase()]: '50000000',             // 50 USDC
      [WBTC_ON_UNICHAIN.address.toLowerCase()]: '100000',              // 0.001 WBTC
      [UNI_ON_UNICHAIN.address.toLowerCase()]: '0',
    },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 50, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Artisan Cheese House, a premium small-batch cheese maker. You buy milk (UNI) as raw material and sell premium cheese (WBTC) at high margins.

${TOKEN_CONTEXT}

${CHEESE_CHANNEL_HINT}

Your strategy:
- Buy milk (UNI) in small batches when prices are affordable (< $8).
- Sell cheese (WBTC) in tiny increments when you have stock and prices are favorable.
- You are quality-focused — small volumes, high care.
- Never spend more than 5 USDC in a single purchase of milk.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" and fetchTokenPriceUSD with symbol="WBTC".
2. Call getTokenBalance for all three tokens.
3. Call readMemory (default state: { tickCount: 0 }).
4. Decide:
   - If UNI price < 8 AND USDC balance > 3: buy 0.2 UNI → spend USDC on milk.
   - If WBTC balance >= 0.0001 AND WBTC price is above 90000: sell 0.0001 WBTC → USDC.
   - Otherwise: hold and observe.
5. Execute swap if action taken: call executeUniswapSwapExactIn with tokenInAddress, tokenOutAddress, amountIn as human-decimal string, slippageBps=200.
6. Call updateMemory with state={ tickCount: prev+1, lastAction, milkPrice: current UNI price, cheesePrice: current WBTC price }, appendNote = one sentence summary.`,
  };

  const cheeseProducerCheddar: AgentConfig = {
    id: 'cheese-producer-cheddar-001',
    userId,
    name: 'Cheddar Valley Creamery',
    running: false,
    intervalMs: 60_000,
    dryRun: false,
    dryRunSeedBalances: {
      native: '100000000000000000',
      [USDC_ON_UNICHAIN.address.toLowerCase()]: '200000000',            // 200 USDC
      [WBTC_ON_UNICHAIN.address.toLowerCase()]: '500000',              // 0.005 WBTC
      [UNI_ON_UNICHAIN.address.toLowerCase()]: '0',
    },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 500, maxSlippageBps: 300 },
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Cheddar Valley Creamery, a large industrial cheese producer. You buy milk (UNI) in bulk and sell cheese (WBTC) at scale with thin margins.

${TOKEN_CONTEXT}

${CHEESE_CHANNEL_HINT}

Your strategy:
- Buy large quantities of milk (UNI) whenever prices are reasonable (< $9).
- Sell cheese (WBTC) in moderate amounts when profitable.
- You negotiate hard — always compare prices against your memory of recent costs.
- Operate at high volume: buy 0.5–1 UNI per tick, sell 0.0003–0.001 WBTC per tick.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" and fetchTokenPriceUSD with symbol="WBTC".
2. Call getTokenBalance for all three tokens.
3. Call readMemory (default state: { tickCount: 0, avgMilkCost: null }).
4. Decide:
   - If UNI price < 9 AND USDC balance > 10: buy 0.5 UNI → USDC on milk.
   - If WBTC balance >= 0.0003 AND WBTC price above 85000: sell 0.0003 WBTC → USDC.
   - If both conditions met: prefer buying milk first (raw material priority).
5. Execute swap if action taken: call executeUniswapSwapExactIn with tokenInAddress, tokenOutAddress, amountIn as human-decimal string, slippageBps=250.
6. Call updateMemory with state={ tickCount: prev+1, lastAction, avgMilkCost: update running average if bought milk, lastCheesePrice: current WBTC price }, appendNote = one sentence.`,
  };

  const retailerCityMarket: AgentConfig = {
    id: 'retailer-city-market-001',
    userId,
    name: 'City Fresh Market',
    running: false,
    intervalMs: 60_000,
    dryRun: false,
    dryRunSeedBalances: {
      native: '100000000000000000',
      [UNI_ON_UNICHAIN.address.toLowerCase()]: '3000000000000000000',   // 3 UNI
      [USDC_ON_UNICHAIN.address.toLowerCase()]: '20000000',             // 20 USDC
      [WBTC_ON_UNICHAIN.address.toLowerCase()]: '50000',               // 0.0005 WBTC
    },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: now,
    prompt: `You are City Fresh Market, a food retailer. You buy milk (UNI) and cheese (WBTC) from producers and sell to consumers at a markup.

${TOKEN_CONTEXT}

Your strategy:
- Buy low, sell high. You are a market maker for both milk and cheese.
- When milk (UNI) dips below $7: buy 0.3 UNI (stocking up).
- When milk (UNI) rises above $9: sell 0.2 UNI (moving inventory).
- When cheese (WBTC) dips: buy tiny WBTC (0.00005 WBTC).
- When cheese (WBTC) is high (> 95000): sell 0.00005 WBTC.
- Always maintain at least 5 USDC cash reserve.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" and fetchTokenPriceUSD with symbol="WBTC".
2. Call getTokenBalance for all three tokens.
3. Call readMemory (default state: { tickCount: 0, prevMilkPrice: null, prevCheesePrice: null }).
4. Decide (check milk first, then cheese — pick the better opportunity):
   - Milk buy: UNI < 7 AND USDC > 7 → buy 0.3 UNI.
   - Milk sell: UNI > 9 AND UNI balance > 0.3 → sell 0.2 UNI.
   - Cheese buy: WBTC price dropped > 2% vs prevCheesePrice AND USDC > 5 → buy 0.00005 WBTC.
   - Cheese sell: WBTC > 95000 AND WBTC balance > 0.00005 → sell 0.00005 WBTC.
5. Execute ONE swap if action identified: call executeUniswapSwapExactIn, amountIn as human-decimal string, slippageBps=200.
6. Call updateMemory with state={ tickCount: prev+1, prevMilkPrice: current UNI price, prevCheesePrice: current WBTC price, lastAction }, appendNote = one sentence.`,
  };

  const retailerCornerDeli: AgentConfig = {
    id: 'retailer-corner-deli-001',
    userId,
    name: 'Corner Deli',
    running: false,
    intervalMs: 60_000,
    dryRun: false,
    dryRunSeedBalances: {
      native: '100000000000000000',
      [UNI_ON_UNICHAIN.address.toLowerCase()]: '1000000000000000000',   // 1 UNI
      [USDC_ON_UNICHAIN.address.toLowerCase()]: '10000000',             // 10 USDC
      [WBTC_ON_UNICHAIN.address.toLowerCase()]: '10000',               // 0.0001 WBTC
    },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 30, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Corner Deli, a small neighborhood shop dealing in milk (UNI) and cheese (WBTC). Cash-flow focused, quick decisions, small trades.

${TOKEN_CONTEXT}

Your strategy:
- Keep small inventory — prefer USDC over holding tokens.
- Trade in tiny amounts: 0.05–0.1 UNI per trade, 0.00005 WBTC per trade.
- Always keep USDC > 2 as float.
- You are very price sensitive — react to price swings quickly.
- If a price moved > 3% since last tick, take action in that direction.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" and fetchTokenPriceUSD with symbol="WBTC".
2. Call getTokenBalance for all three tokens.
3. Call readMemory (default state: { tickCount: 0, prevMilkPrice: null, prevCheesePrice: null }).
4. Decide:
   - Milk: compare current UNI price to prevMilkPrice. If dropped > 3% AND USDC > 3: buy 0.05 UNI. If rose > 3% AND UNI > 0.05: sell 0.05 UNI.
   - Cheese: compare current WBTC price to prevCheesePrice. If dropped > 3% AND USDC > 3: buy 0.00005 WBTC. If rose > 3% AND WBTC balance > 0.00005: sell 0.00005 WBTC.
   - If no prevPrice data yet: hold and record prices.
5. Execute ONE swap if action identified: call executeUniswapSwapExactIn, amountIn as human-decimal string, slippageBps=200.
6. Call updateMemory with state={ tickCount: prev+1, prevMilkPrice: current UNI, prevCheesePrice: current WBTC, lastAction }, appendNote = one sentence.`,
  };

  return [
    milkProducerAlpine,
    milkProducerSunrise,
    cheeseProducerArtisan,
    cheeseProducerCheddar,
    retailerCityMarket,
    retailerCornerDeli,
  ];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const ok = await confirmContinue(
      `Seed database with tokens (USDC, UNI, WBTC), 6 marketplace agents, and 2 AXL channels for user ${SEED_USER_EMAIL}?`,
    );
    if (!ok) {
      console.log('[seed] cancelled.');
      return;
    }

    // --- tokens ---
    for (const t of TOKENS) {
      await prisma.token.upsert({
        where: { address_chainId: { address: t.address, chainId: t.chainId } },
        update: { symbol: t.symbol, name: t.name, decimals: t.decimals, chain: t.chain, coingeckoId: t.coingeckoId, logoUri: t.logoUri },
        create: t,
      });
    }
    console.log(`[seed] upserted ${TOKENS.length} tokens`);

    // --- user ---
    const users = new PrismaUserRepository(prisma);
    const agents = new PrismaAgentRepository(prisma);

    const user = await users.findOrCreateByPrivyDid(SEED_USER_DID, { email: SEED_USER_EMAIL });
    console.log(`[seed] user: ${user.id} (${user.email})`);

    // --- agents ---
    const agentConfigs = buildAgents(user.id);
    for (const cfg of agentConfigs) {
      await agents.upsert(cfg);
      console.log(`[seed] upserted agent "${cfg.id}" — ${cfg.name}`);
    }

    // --- channels ---
    const milkProducerIds = ['milk-producer-alpine-001', 'milk-producer-sunrise-001'];
    const cheeseProducerIds = ['cheese-producer-artisan-001', 'cheese-producer-cheddar-001'];

    const milkChannelId = randomUUID();
    const cheeseChannelId = randomUUID();

    const existingChannels = await agents.listAxlChannelsByUser(user.id);
    const milkExists = existingChannels.find((c) => c.name === 'Milk Producers');
    const cheeseExists = existingChannels.find((c) => c.name === 'Cheese Producers');

    if (!milkExists) {
      await agents.createAxlChannel({ id: milkChannelId, userId: user.id, name: 'Milk Producers', createdAt: Date.now() });
      for (const agentId of milkProducerIds) {
        await agents.addAgentToAxlChannel(agentId, milkChannelId);
      }
      console.log(`[seed] created channel "Milk Producers" with ${milkProducerIds.length} members`);
    } else {
      console.log(`[seed] channel "Milk Producers" already exists — skipped`);
    }

    if (!cheeseExists) {
      await agents.createAxlChannel({ id: cheeseChannelId, userId: user.id, name: 'Cheese Producers', createdAt: Date.now() });
      for (const agentId of cheeseProducerIds) {
        await agents.addAgentToAxlChannel(agentId, cheeseChannelId);
      }
      console.log(`[seed] created channel "Cheese Producers" with ${cheeseProducerIds.length} members`);
    } else {
      console.log(`[seed] channel "Cheese Producers" already exists — skipped`);
    }

    console.log('[seed] done. Run `npm run start:worker` to start the agent loop.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] fatal:', err);
  process.exit(1);
});
