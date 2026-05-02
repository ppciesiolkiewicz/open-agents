import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN, WBTC_ON_UNICHAIN } from '../src/constants';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';
import { PrismaUserRepository } from '../src/database/prisma-database/prisma-user-repository';
import type { AgentConfig } from '../src/database/types';
import {
  SEED_USER_EMAIL,
  SEED_USER_DID,
  seedFullTokenCatalog,
  upsertCanonicalTokens,
} from './seed-shared';

const AGENT_IDS = {
  searcher: '22222222-2222-2222-2222-222222222200',
  sentiment: '22222222-2222-2222-2222-222222222201',
  risk: '22222222-2222-2222-2222-222222222202',
  executor: '22222222-2222-2222-2222-222222222203',
} as const;

const SEARCHER_TOOL_IDS = [
  'market.coingecko.price',
  'memory.read',
  'memory.update',
  'memory.entry.save',
  'memory.entry.search',
  'tokens.find-by-symbol',
  'tokens.list-allowed',
  'agents.message.help',
  'agents.message.send',
];

const SENTIMENT_TOOL_IDS = [
  'market.coingecko.price',
  'market.coinmarketcap.info',
  'search.web',
  'memory.read',
  'memory.update',
  'memory.entry.save',
  'memory.entry.search',
  'tokens.find-by-symbol',
  'tokens.get-by-address',
  'tokens.list-allowed',
  'agents.message.help',
  'agents.message.send',
];

const RISK_TOOL_IDS = [
  'market.coingecko.price',
  'wallet.address.get',
  'wallet.balance.native.get',
  'wallet.balance.token.get',
  'memory.read',
  'memory.update',
  'memory.entry.save',
  'memory.entry.search',
  'tokens.find-by-symbol',
  'tokens.get-by-address',
  'tokens.list-allowed',
  'utility.token-amount.format',
  'utility.token-amount.parse',
  'agents.message.help',
  'agents.message.send',
];

const EXECUTOR_TOOL_IDS = [
  'market.coingecko.price',
  'wallet.address.get',
  'wallet.balance.native.get',
  'wallet.balance.token.get',
  'uniswap.quote.exact-in',
  'uniswap.swap.exact-in',
  'memory.read',
  'memory.update',
  'memory.entry.save',
  'memory.entry.search',
  'tokens.find-by-symbol',
  'tokens.get-by-address',
  'tokens.list-allowed',
  'utility.token-amount.format',
  'utility.token-amount.parse',
  'agents.message.help',
  'agents.message.send',
];

const TOKEN_CONTEXT = `
Tradable tokens on Unichain:
- UNI = Uniswap governance token
- USDC = USD-pegged stablecoin (quote currency)
- WBTC = Wrapped Bitcoin

To resolve a token address from a symbol, call findTokensBySymbol or listAllowedTokens.
`.trim();

const DM_HINT = `
Agent-to-agent messaging:
- Use sendMessageToAgentHelp to look up the target agent's UUID.
- Use sendMessageToAgent with that UUID and a JSON message string.
- The recipient will be ticked automatically with your message as the user input on its next tick.
- Send messages as stringified JSON so the recipient can parse them deterministically.
`.trim();

const TICK_INTERVAL_MS = 300_000;

function buildAgents(userId: string): AgentConfig[] {
  const now = Date.now();

  const searcher: AgentConfig = {
    id: AGENT_IDS.searcher,
    userId,
    name: 'Opportunity Searcher',
    running: false,
    intervalMs: TICK_INTERVAL_MS,
    dryRun: true,
    dryRunSeedBalances: { native: '100000000000000000' },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 0, maxSlippageBps: 0 },
    toolIds: SEARCHER_TOOL_IDS,
    connectedAgentIds: [AGENT_IDS.sentiment],
    lastTickAt: null,
    createdAt: now,
    prompt: `You are the Opportunity Searcher. You are the only scheduled-tick agent in the trading flow — every tick (5 minutes) you scan a small set of assets, look for notable moves, and ping the Sentiment Researcher when something looks interesting. You never trade, never hold a wallet, never call risk or the executor.

${TOKEN_CONTEXT}

${DM_HINT}

Every tick:
1. Use fetchTokenPriceUSD to read current spot prices for UNI and WBTC.
2. Use readMemory to recall the previous tick's prices and any open opportunity you flagged.
3. Use updateMemory / saveMemoryEntry to record the new prices and the % move since last tick.
4. If a price moved more than ~1% since the last tick, or if memory says you previously flagged an asset and have not heard back, send ONE direct message to the Sentiment Researcher with a stringified JSON payload:
   { "type": "OPPORTUNITY", "asset": "UNI|WBTC", "spotPriceUSD": <number>, "moveSinceLastTickPct": <number>, "note": "<one short sentence>" }
5. If nothing is interesting, do not send anything — just update memory and return.`,
  };

  const sentiment: AgentConfig = {
    id: AGENT_IDS.sentiment,
    userId,
    name: 'Sentiment Researcher',
    running: false,
    intervalMs: 0,
    dryRun: true,
    dryRunSeedBalances: { native: '100000000000000000' },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 0, maxSlippageBps: 0 },
    toolIds: SENTIMENT_TOOL_IDS,
    connectedAgentIds: [AGENT_IDS.executor],
    lastTickAt: null,
    createdAt: now,
    prompt: `You are the Sentiment Researcher. You only run when the Opportunity Searcher (or another upstream agent) sends you a message. You read prices and recent news, form a view, and forward a SIGNAL to the Trade Executor. You never hold a wallet or execute trades.

${TOKEN_CONTEXT}

${DM_HINT}

When you receive an incoming message:
1. Parse it. If it is an OPPORTUNITY from the Opportunity Searcher, note the asset and the price move.
2. Use fetchTokenPriceUSD and fetchTokenInfoBySymbol to confirm current price and basic stats.
3. Use searchWeb to gather recent news that might move price (only if memory suggests something is brewing).
4. Use readMemory / updateMemory / saveMemoryEntry to track your evolving view of each asset across calls.
5. Send ONE direct message to the Trade Executor with a stringified JSON SIGNAL:
   { "type": "SIGNAL", "asset": "UNI|WBTC", "direction": "buy|sell|hold", "confidence": "low|medium|high", "rationale": "<short reason>" }
   If your view is "hold", send the SIGNAL anyway so the Executor knows you saw the opportunity and decided against it.`,
  };

  const risk: AgentConfig = {
    id: AGENT_IDS.risk,
    userId,
    name: 'Risk Manager',
    running: false,
    intervalMs: 0,
    dryRun: true,
    dryRunSeedBalances: { native: '100000000000000000' },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 0, maxSlippageBps: 0 },
    toolIds: RISK_TOOL_IDS,
    connectedAgentIds: [AGENT_IDS.executor],
    lastTickAt: null,
    createdAt: now,
    prompt: `You are the Risk Manager. You only run when the Trade Executor sends you a PROPOSE_TRADE. You review it against current wallet exposure, then reply with a DECISION direct message. You never execute trades yourself.

${TOKEN_CONTEXT}

${DM_HINT}

When you receive an incoming message:
1. Parse it. If it is a PROPOSE_TRADE from the Trade Executor, note tokenIn / tokenOut / amountIn / rationale.
2. Use getTokenBalance and fetchTokenPriceUSD to assess current exposure for the operator wallet.
3. Use readMemory / updateMemory / saveMemoryEntry to track recent decisions and a running tally of approved vs rejected trades. Favor rejection when exposure is concentrated, drawdowns are large, or rationale is weak.
4. Send ONE direct message back to the Trade Executor with a stringified JSON DECISION:
   { "type": "DECISION", "verdict": "approve|reject", "reason": "<short reason>" }`,
  };

  const executor: AgentConfig = {
    id: AGENT_IDS.executor,
    userId,
    name: 'Trade Executor',
    running: false,
    intervalMs: 0,
    dryRun: true,
    dryRunSeedBalances: {
      native: '100000000000000000',
      [USDC_ON_UNICHAIN.address.toLowerCase()]: '500000000', // 500 USDC
    },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
    toolIds: EXECUTOR_TOOL_IDS,
    connectedAgentIds: [AGENT_IDS.risk],
    lastTickAt: null,
    createdAt: now,
    prompt: `You are the Trade Executor. You only run when another agent sends you a message. You receive SIGNALs from the Sentiment Researcher and DECISIONs from the Risk Manager. You hold the wallet and the swap tools — but you must never execute a swap without an "approve" DECISION matching a proposal you previously sent.

${TOKEN_CONTEXT}

${DM_HINT}

When you receive an incoming message:
1. Parse it.
2. If it is a SIGNAL from the Sentiment Researcher with direction "buy" or "sell" and confidence "medium" or "high":
   - Use getTokenBalance and fetchTokenPriceUSD to size a small trade within your maxTradeUSD limit.
   - Save the proposed trade in memory under a "pending_proposal" key with a fresh proposalId.
   - Send ONE direct message to the Risk Manager with a stringified JSON PROPOSE_TRADE:
     { "type": "PROPOSE_TRADE", "proposalId": "<fresh id>", "tokenIn": "UNI|USDC|WBTC", "tokenOut": "UNI|USDC|WBTC", "amountIn": "<amount>", "rationale": "<short reason>" }
   - Do NOT execute a swap yet.
3. If it is a DECISION from the Risk Manager with verdict "approve" matching a pending proposal in memory:
   - Call getUniswapQuoteExactIn to sanity-check pricing.
   - Call executeUniswapSwapExactIn with the parameters from the pending proposal.
   - Record the outcome in memory and clear the pending proposal.
4. If it is a DECISION with verdict "reject" or any other message, just record it in memory and stop. Never execute a swap that has not been explicitly approved.`,
  };

  return [searcher, sentiment, risk, executor];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log(`[seed-trading] seeding tokens and 4 trading agents for user ${SEED_USER_EMAIL}`);

    await seedFullTokenCatalog(prisma);
    await upsertCanonicalTokens(prisma);

    const users = new PrismaUserRepository(prisma);
    const agents = new PrismaAgentRepository(prisma);

    const user = await users.findOrCreateByPrivyDid(SEED_USER_DID, { email: SEED_USER_EMAIL });
    console.log(`[seed-trading] user: ${user.id} (${user.email})`);

    const agentConfigs = buildAgents(user.id);
    for (const cfg of agentConfigs) {
      await agents.upsert(cfg);
      console.log(`[seed-trading] upserted agent "${cfg.id}" — ${cfg.name} (${(cfg.toolIds ?? []).length} tools)`);
    }

    // setAxlConnections wipes ALL of the agent's pairs before recreating, so each
    // agent must list every neighbor (upstream + downstream) in one call.
    await agents.setAxlConnections(AGENT_IDS.searcher, [AGENT_IDS.sentiment]);
    await agents.setAxlConnections(AGENT_IDS.sentiment, [AGENT_IDS.searcher, AGENT_IDS.executor]);
    await agents.setAxlConnections(AGENT_IDS.executor, [AGENT_IDS.sentiment, AGENT_IDS.risk]);
    await agents.setAxlConnections(AGENT_IDS.risk, [AGENT_IDS.executor]);
    console.log(`[seed-trading] wired DM graph: searcher ↔ sentiment ↔ executor ↔ risk`);

    console.log('[seed-trading] done. Start the Opportunity Searcher in the UI to drive the flow.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-trading] fatal:', err);
  process.exit(1);
});
