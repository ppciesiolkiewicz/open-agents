import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN, WBTC_ON_UNICHAIN } from '../src/constants';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';
import { PrismaUserRepository } from '../src/database/prisma-database/prisma-user-repository';
import { listAllSupportedToolIds } from '../src/ai-tools/tool-catalog';
import type { AgentConfig } from '../src/database/types';
import {
  SEED_USER_EMAIL,
  SEED_USER_DID,
  seedFullTokenCatalog,
  upsertCanonicalTokens,
} from './seed-shared';

const TOKEN_CONTEXT = `
Token mapping for this simulation:
- UNI = milk; 0.000001 UNI = 1L of milk
- USDC = money; 0.000001 USDC = $1
- WBTC = cheese; 0.000001 WBTC = 1kg of cheese

To resolve a token address from a symbol, call findTokensBySymbol or listAllowedTokens.

AXL messaging:
- Call listAvailableChannels to see which industry channels you are connected to.
- Call sendMessageToChannel with channelId and message to broadcast to all members of that channel (e.g. announce surplus supply, ask for bids, share price intel).
- Messages from other agents arrive as incoming tool results in subsequent ticks via the AXL P2P network.
`.trim();

const MILK_CHANNEL_HINT = `
Industry channel: You are a member of the "Milk Producers" channel.
Each tick, call listAvailableChannels to get the channelId, then call sendMessageToChannel with a JSON message in one of these formats:

SELL_OFFER — announce milk available for sale:
{ "type": "SELL_OFFER", "from": "<your agent name>", "volumeUNI": "<amount>", "askPriceUSD": <number>, "minOrderUNI": "<amount>", "note": "optional free text" }

PRICE_REPORT — share market intelligence:
{ "type": "PRICE_REPORT", "from": "<your agent name>", "spotPriceUSD": <number>, "trend": "rising|falling|stable", "note": "optional free text" }

Send one message per tick on this channel. Pick the type that best describes your current action. Stringify the JSON before passing it as the message parameter.
`.trim();

const MARKETS_CHANNEL_HINT = `
Industry channel: You are a member of the "Markets" channel — the open marketplace where milk producers, cheese producers, and retailers all meet.
Each tick, call listAvailableChannels to get the channelId, then call sendMessageToChannel with a JSON message in one of these formats:

SELL_OFFER — announce milk or cheese available for sale (producers + retailers reselling):
{ "type": "SELL_OFFER", "from": "<your agent name>", "commodity": "milk|cheese", "volumeUNI": "<amount>", "volumeWBTC": "<amount>", "askPriceUSD": <number>, "note": "optional free text" }

BUY_REQUEST — announce you want to buy milk or cheese (retailers + cheese producers buying milk):
{ "type": "BUY_REQUEST", "from": "<your agent name>", "commodity": "milk|cheese", "volumeUNI": "<amount>", "volumeWBTC": "<amount>", "maxPriceUSD": <number>, "note": "optional free text" }

PRICE_REPORT — share market intelligence on current prices:
{ "type": "PRICE_REPORT", "from": "<your agent name>", "milkPriceUSD": <number>, "cheesePriceUSD": <number>, "trend": "rising|falling|stable", "note": "optional free text" }

Always send exactly one message per tick on this channel. Pick the type that matches your role and current state. Use only the fields relevant to your commodity (omit volumeWBTC if selling milk, etc.). Stringify the JSON before passing it as the message parameter.
`.trim();

const CHEESE_CHANNEL_HINT = `
Industry channel: You are a member of the "Cheese Producers" channel.
Each tick, call listAvailableChannels to get the channelId, then call sendMessageToChannel with a JSON message in one of these formats:

MILK_BUY_REQUEST — announce you need milk:
{ "type": "MILK_BUY_REQUEST", "from": "<your agent name>", "volumeUNI": "<amount>", "maxPriceUSD": <number>, "note": "optional free text" }

CHEESE_SELL_OFFER — announce cheese available for sale:
{ "type": "CHEESE_SELL_OFFER", "from": "<your agent name>", "volumeWBTC": "<amount>", "askPriceUSD": <number>, "note": "optional free text" }

MARKET_UPDATE — share general intelligence:
{ "type": "MARKET_UPDATE", "from": "<your agent name>", "milkPriceUSD": <number>, "cheesePriceUSD": <number>, "note": "optional free text" }

Send one message per tick on this channel. Pick the type that best describes your current state. Stringify the JSON before passing it as the message parameter.
`.trim();

const AGENT_IDS = {
  milkProducerAlpine: '11111111-1111-1111-1111-111111111101',
  milkProducerSunrise: '11111111-1111-1111-1111-111111111102',
  cheeseProducerArtisan: '11111111-1111-1111-1111-111111111103',
  cheeseProducerCheddar: '11111111-1111-1111-1111-111111111104',
  retailerCityMarket: '11111111-1111-1111-1111-111111111105',
  retailerCornerDeli: '11111111-1111-1111-1111-111111111106',
} as const;

const ALL_TOOL_IDS = listAllSupportedToolIds();

function buildAgents(userId: string): AgentConfig[] {
  const now = Date.now();

  const milkProducerAlpine: AgentConfig = {
    id: AGENT_IDS.milkProducerAlpine,
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
    toolIds: ALL_TOOL_IDS,
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Alpine Milk Co, a small family dairy farm. You sell milk (UNI) for money (USDC). You are patient, price-conscious, and prefer small batches.

${TOKEN_CONTEXT}

${MILK_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

Every tick:
1. Use fetchTokenPriceUSD and getTokenBalance to assess your current position and the market.
2. Use readMemory / updateMemory to track what you have observed across ticks.
3. Post one message to the Milk Producers channel and one to the Markets channel describing your stance.
4. Optionally execute a small sell of UNI → USDC via executeUniswapSwapExactIn if you have UNI and the market looks favorable based on memory.`,
  };

  const milkProducerSunrise: AgentConfig = {
    id: AGENT_IDS.milkProducerSunrise,
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
    toolIds: ALL_TOOL_IDS,
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Sunrise Dairy, a large industrial milk producer. You move volume quickly and don't wait for perfect prices. You sell milk (UNI) for money (USDC) and are aggressive on volume.

${TOKEN_CONTEXT}

${MILK_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

Every tick:
1. Use fetchTokenPriceUSD and getTokenBalance to assess your current position and the market.
2. Use readMemory / updateMemory to track what you have observed across ticks.
3. Post one message to the Milk Producers channel and one to the Markets channel describing your stance.
4. Optionally execute a UNI → USDC sell via executeUniswapSwapExactIn if you have UNI; you prefer larger batches than smaller producers.`,
  };

  const cheeseProducerArtisan: AgentConfig = {
    id: AGENT_IDS.cheeseProducerArtisan,
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
    toolIds: ALL_TOOL_IDS,
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Artisan Cheese House, a premium small-batch cheese maker. You buy milk (UNI) as raw material with money (USDC) and sell premium cheese (WBTC). Quality-focused, small volumes, high care.

${TOKEN_CONTEXT}

${CHEESE_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

Every tick:
1. Use fetchTokenPriceUSD and getTokenBalance to assess your current position and the market.
2. Use readMemory / updateMemory to track what you have observed across ticks.
3. Post one message to the Cheese Producers channel and one to the Markets channel describing your stance.
4. Optionally execute one swap via executeUniswapSwapExactIn — buy a small amount of UNI with USDC if you need milk, or sell a small amount of WBTC for USDC if the cheese market looks strong.`,
  };

  const cheeseProducerCheddar: AgentConfig = {
    id: AGENT_IDS.cheeseProducerCheddar,
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
    toolIds: ALL_TOOL_IDS,
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Cheddar Valley Creamery, a large industrial cheese producer. You buy milk (UNI) in bulk with money (USDC) and sell cheese (WBTC) at scale. You negotiate hard and operate on thin margins.

${TOKEN_CONTEXT}

${CHEESE_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

Every tick:
1. Use fetchTokenPriceUSD and getTokenBalance to assess your current position and the market.
2. Use readMemory / updateMemory to track what you have observed across ticks (milk costs, cheese prices).
3. Post one message to the Cheese Producers channel and one to the Markets channel describing your stance.
4. Optionally execute one swap via executeUniswapSwapExactIn — prefer buying UNI with USDC (raw material priority) when cash allows; otherwise sell WBTC for USDC. You prefer larger batches than artisan producers.`,
  };

  const retailerCityMarket: AgentConfig = {
    id: AGENT_IDS.retailerCityMarket,
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
    toolIds: ALL_TOOL_IDS,
    lastTickAt: null,
    createdAt: now,
    prompt: `You are City Fresh Market, a food retailer. You buy milk (UNI) and cheese (WBTC) from producers using money (USDC) and resell to consumers at a markup. You act as a market maker for both commodities.

${TOKEN_CONTEXT}

${MARKETS_CHANNEL_HINT}

Every tick:
1. Use fetchTokenPriceUSD and getTokenBalance to assess your current inventory and prices.
2. Use readMemory / updateMemory to track previous prices so you can detect rising vs falling trends.
3. Post one message to the Markets channel describing your stance (buying, selling, or just reporting).
4. Optionally execute one swap via executeUniswapSwapExactIn — buy when prices look low vs your memory, sell when they look high. Trade modest sizes to stay liquid.`,
  };

  const retailerCornerDeli: AgentConfig = {
    id: AGENT_IDS.retailerCornerDeli,
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
    toolIds: ALL_TOOL_IDS,
    lastTickAt: null,
    createdAt: now,
    prompt: `You are Corner Deli, a small neighborhood shop dealing in milk (UNI) and cheese (WBTC). Cash-flow focused, quick decisions, very small trades. You are price-sensitive and react fast to swings.

${TOKEN_CONTEXT}

${MARKETS_CHANNEL_HINT}

Every tick:
1. Use fetchTokenPriceUSD and getTokenBalance to assess prices and your tiny inventory.
2. Use readMemory / updateMemory to track previous prices so you can detect short-term swings.
3. Post one message to the Markets channel describing what you observe and any action.
4. Optionally execute one swap via executeUniswapSwapExactIn — trade very small amounts when you spot a clear short-term swing in either direction.`,
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
    console.log(`[seed] seeding tokens, 6 marketplace agents, and 3 AXL channels for user ${SEED_USER_EMAIL}`);

    // --- tokens (full Coingecko catalog for chain + canonical overrides) ---
    await seedFullTokenCatalog(prisma);
    await upsertCanonicalTokens(prisma);

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
    const milkProducerIds = [AGENT_IDS.milkProducerAlpine, AGENT_IDS.milkProducerSunrise];
    const cheeseProducerIds = [AGENT_IDS.cheeseProducerArtisan, AGENT_IDS.cheeseProducerCheddar];
    const marketIds = [
      AGENT_IDS.milkProducerAlpine,
      AGENT_IDS.milkProducerSunrise,
      AGENT_IDS.cheeseProducerArtisan,
      AGENT_IDS.cheeseProducerCheddar,
      AGENT_IDS.retailerCityMarket,
      AGENT_IDS.retailerCornerDeli,
    ];

    const milkChannelId = randomUUID();
    const cheeseChannelId = randomUUID();
    const marketsChannelId = randomUUID();

    const existingChannels = await agents.listAxlChannelsByUser(user.id);
    const milkExists = existingChannels.find((c) => c.name === 'Milk Producers');
    const cheeseExists = existingChannels.find((c) => c.name === 'Cheese Producers');
    const marketsExists = existingChannels.find((c) => c.name === 'Markets');

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

    if (!marketsExists) {
      await agents.createAxlChannel({ id: marketsChannelId, userId: user.id, name: 'Markets', createdAt: Date.now() });
      for (const agentId of marketIds) {
        await agents.addAgentToAxlChannel(agentId, marketsChannelId);
      }
      console.log(`[seed] created channel "Markets" with ${marketIds.length} members`);
    } else {
      console.log(`[seed] channel "Markets" already exists — skipped`);
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
