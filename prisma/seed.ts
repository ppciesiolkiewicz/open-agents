import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN, WBTC_ON_UNICHAIN } from '../src/constants';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';
import { PrismaUserRepository } from '../src/database/prisma-database/prisma-user-repository';
import { listAllSupportedToolIds } from '../src/ai-tools/tool-catalog';
import type { AgentConfig } from '../src/database/types';

const CHAIN_ID_TO_NAME: Record<number, string> = { 130: 'unichain' };
const TOKEN_LIST_URLS: Record<string, string> = {
  unichain: 'https://tokens.coingecko.com/unichain/all.json',
};
const COINGECKO_COINS_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const COINGECKO_CACHE_PATH = path.resolve(process.cwd(), 'db', 'coingecko-coins-list.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CoinGeckoToken {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

interface CoinGeckoTokenList {
  tokens: CoinGeckoToken[];
}

interface CoinGeckoCoin {
  id: string;
  symbol: string;
  name: string;
  platforms: Record<string, string | null>;
}

async function fetchTokenList(url: string): Promise<CoinGeckoToken[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch token list: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as CoinGeckoTokenList;
  return data.tokens;
}

async function loadCoingeckoCoinList(): Promise<CoinGeckoCoin[]> {
  try {
    const stat = await fs.stat(COINGECKO_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < CACHE_TTL_MS) {
      const buf = await fs.readFile(COINGECKO_CACHE_PATH, 'utf8');
      return JSON.parse(buf) as CoinGeckoCoin[];
    }
  } catch {
    // cache miss
  }
  console.log(`[seed] fetching CoinGecko coin list (~10MB) from ${COINGECKO_COINS_LIST_URL}...`);
  const res = await fetch(COINGECKO_COINS_LIST_URL);
  if (!res.ok) throw new Error(`coins/list failed: ${res.status} ${res.statusText}`);
  const list = (await res.json()) as CoinGeckoCoin[];
  await fs.mkdir(path.dirname(COINGECKO_CACHE_PATH), { recursive: true });
  await fs.writeFile(COINGECKO_CACHE_PATH, JSON.stringify(list));
  return list;
}

function buildAddressToCoingeckoId(coins: CoinGeckoCoin[], platformKey: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const coin of coins) {
    const addr = coin.platforms?.[platformKey];
    if (addr) map.set(addr.toLowerCase(), coin.id);
  }
  return map;
}

async function seedFullTokenCatalog(prisma: PrismaClient): Promise<void> {
  const coins = await loadCoingeckoCoinList();
  for (const [chain, url] of Object.entries(TOKEN_LIST_URLS)) {
    console.log(`[seed] fetching ${chain} token list...`);
    const tokens = await fetchTokenList(url);
    console.log(`[seed] ${tokens.length} tokens fetched`);

    const idMap = buildAddressToCoingeckoId(coins, chain);
    console.log(`[seed] ${idMap.size} ${chain} addresses have a coingeckoId`);

    let upserted = 0;
    for (const token of tokens) {
      const chainName = CHAIN_ID_TO_NAME[token.chainId] ?? chain;
      const lowerAddr = token.address.toLowerCase();
      const coingeckoId = idMap.get(lowerAddr) ?? null;
      await prisma.token.upsert({
        where: { address_chainId: { address: lowerAddr, chainId: token.chainId } },
        update: {
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          logoUri: token.logoURI ?? null,
          chain: chainName,
          coingeckoId,
        },
        create: {
          chainId: token.chainId,
          chain: chainName,
          address: lowerAddr,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          logoUri: token.logoURI ?? null,
          coingeckoId,
        },
      });
      upserted++;
    }
    console.log(`[seed] upserted ${upserted} tokens for chain "${chain}"`);
  }
}

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
  },
  {
    chainId: 130,
    chain: 'unichain',
    address: UNI_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    coingeckoId: UNI_ON_UNICHAIN.coingeckoId,
  },
  {
    chainId: 130,
    chain: 'unichain',
    address: WBTC_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    coingeckoId: WBTC_ON_UNICHAIN.coingeckoId,
  },
];

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
{ "type": "SELL_OFFER", "from": "<your agent name>", "volumeUNI": "0.20", "askPriceUSD": 8.50, "minOrderUNI": "0.05", "note": "optional free text" }

PRICE_REPORT — share market intelligence:
{ "type": "PRICE_REPORT", "from": "<your agent name>", "spotPriceUSD": 8.42, "trend": "rising|falling|stable", "note": "optional free text" }

Send one message per tick on this channel. Pick the type that best describes your current action. Stringify the JSON before passing it as the message parameter.
`.trim();

const MARKETS_CHANNEL_HINT = `
Industry channel: You are a member of the "Markets" channel — the open marketplace where milk producers, cheese producers, and retailers all meet.
Each tick, call listAvailableChannels to get the channelId, then call sendMessageToChannel with a JSON message in one of these formats:

SELL_OFFER — announce milk or cheese available for sale (producers + retailers reselling):
{ "type": "SELL_OFFER", "from": "<your agent name>", "commodity": "milk|cheese", "volumeUNI": "0.20", "volumeWBTC": "0.0003", "askPriceUSD": 8.50, "note": "optional free text" }

BUY_REQUEST — announce you want to buy milk or cheese (retailers + cheese producers buying milk):
{ "type": "BUY_REQUEST", "from": "<your agent name>", "commodity": "milk|cheese", "volumeUNI": "0.30", "volumeWBTC": "0.00005", "maxPriceUSD": 8.00, "note": "optional free text" }

PRICE_REPORT — share market intelligence on current prices:
{ "type": "PRICE_REPORT", "from": "<your agent name>", "milkPriceUSD": 8.42, "cheesePriceUSD": 91500, "trend": "rising|falling|stable", "note": "optional free text" }

Always send exactly one message per tick on this channel. Pick the type that matches your role and current state. Use only the fields relevant to your commodity (omit volumeWBTC if selling milk, etc.). Stringify the JSON before passing it as the message parameter.
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
    prompt: `You are Alpine Milk Co, a small family dairy farm. You sell milk (UNI tokens) to generate revenue (USDC).

${TOKEN_CONTEXT}

${MILK_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

Your strategy:
- You are patient and price-conscious. Only sell milk when the UNI price meets your floor.
- Sell in small batches (0.1–0.3 UNI) to avoid flooding the market.
- Keep at least 2 UNI in reserve as buffer stock.
- If prices are very good (>$10), you are willing to sell a larger batch as a bonus sale.
- Never hold less than 1 USDC — that's your operating cash.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" to get current milk price.
2. Resolve UNI and USDC addresses via findTokensBySymbol or listAllowedTokens, then call getTokenBalance for each.
3. Call readMemory to load your state (default state: { lastSignal: null, tickCount: 0 }).
4. Decide action:
   - If UNI price > 10 AND UNI balance > 2: sell 0.3 UNI → USDC (opportunistic bulk).
   - Else if UNI price > 8 AND UNI balance > 2: sell 0.2 UNI → USDC (standard sale).
   - Otherwise: hold, note market too low or stock too thin.
5. If selling: call executeUniswapSwapExactIn with tokenInAddress=<UNI address>, tokenOutAddress=<USDC address>, amountIn as a human-decimal string (e.g. "0.2"), slippageBps=200.
6. Call updateMemory with state={ tickCount: prev+1, lastAction, lastPrice: current UNI price }, appendNote = one sentence summary.`,
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
    prompt: `You are Sunrise Dairy, a large industrial milk producer. You move volume quickly and don't wait for perfect prices.

${TOKEN_CONTEXT}

${MILK_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

Your strategy:
- You are a volume seller — sell large amounts even at thin margins.
- Sell whenever UNI price > $6. Don't overthink it.
- If milk prices are very cheap (<$5) and you have spare USDC, buy more milk stock cheaply.
- You have no patience for holding USDC idle — convert it to milk or sell milk constantly.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI".
2. Resolve UNI and USDC addresses via findTokensBySymbol or listAllowedTokens, then call getTokenBalance for each.
3. Call readMemory to load state (default: { tickCount: 0 }).
4. Decide action:
   - If UNI price > 6 AND UNI balance > 3: sell 1.5 UNI → USDC.
   - Else if UNI price < 5 AND USDC balance > 5: buy 1 UNI with USDC (restock at discount).
   - Otherwise: hold.
5. Execute swap if action taken: call executeUniswapSwapExactIn with appropriate tokenInAddress, tokenOutAddress, amountIn as human-decimal string, slippageBps=250.
6. Call updateMemory with state={ tickCount: prev+1, lastAction, lastPrice }, appendNote = one sentence summary.`,
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
    prompt: `You are Artisan Cheese House, a premium small-batch cheese maker. You buy milk (UNI) as raw material and sell premium cheese (WBTC) at high margins.

${TOKEN_CONTEXT}

${CHEESE_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

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
    prompt: `You are Cheddar Valley Creamery, a large industrial cheese producer. You buy milk (UNI) in bulk and sell cheese (WBTC) at scale with thin margins.

${TOKEN_CONTEXT}

${CHEESE_CHANNEL_HINT}

${MARKETS_CHANNEL_HINT}

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
    prompt: `You are City Fresh Market, a food retailer. You buy milk (UNI) and cheese (WBTC) from producers and sell to consumers at a markup.

${TOKEN_CONTEXT}

${MARKETS_CHANNEL_HINT}

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
    prompt: `You are Corner Deli, a small neighborhood shop dealing in milk (UNI) and cheese (WBTC). Cash-flow focused, quick decisions, small trades.

${TOKEN_CONTEXT}

${MARKETS_CHANNEL_HINT}

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
    console.log(`[seed] seeding tokens, 6 marketplace agents, and 3 AXL channels for user ${SEED_USER_EMAIL}`);

    // --- tokens (full Coingecko catalog for chain) ---
    await seedFullTokenCatalog(prisma);

    // --- tokens (canonical USDC/UNI/WBTC overrides) ---
    for (const t of TOKENS) {
      await prisma.token.upsert({
        where: { address_chainId: { address: t.address, chainId: t.chainId } },
        update: { symbol: t.symbol, name: t.name, decimals: t.decimals, chain: t.chain, coingeckoId: t.coingeckoId },
        create: t,
      });
    }
    console.log(`[seed] upserted ${TOKENS.length} canonical tokens (USDC/UNI/WBTC)`);

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
