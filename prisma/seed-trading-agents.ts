import 'dotenv/config';
import { randomUUID } from 'node:crypto';
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
  sentiment: '22222222-2222-2222-2222-222222222201',
  risk: '22222222-2222-2222-2222-222222222202',
  executor: '22222222-2222-2222-2222-222222222203',
} as const;

const SENTIMENT_TOOL_IDS = [
  'market.coingecko.price',
  'market.coinmarketcap.info',
  'search.web',
  'web.scrape.markdown',
  'memory.read',
  'memory.update',
  'memory.entry.save',
  'memory.entry.search',
  'tokens.find-by-symbol',
  'tokens.get-by-address',
  'tokens.list-allowed',
  'agents.channels.list',
  'agents.channel-message.send',
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
  'agents.channels.list',
  'agents.channel-message.send',
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
  'agents.channels.list',
  'agents.channel-message.send',
];

const TOKEN_CONTEXT = `
Tradable tokens on Unichain:
- UNI = Uniswap governance token
- USDC = USD-pegged stablecoin (quote currency)
- WBTC = Wrapped Bitcoin

To resolve a token address from a symbol, call findTokensBySymbol or listAllowedTokens.
`.trim();

const SIGNALS_CHANNEL_HINT = `
Channel: "Trading Signals" — sentiment publishes here, executor listens.

SIGNAL message format:
{ "type": "SIGNAL", "from": "<your agent name>", "asset": "UNI|WBTC", "direction": "buy|sell|hold", "confidence": "low|medium|high", "rationale": "<short reason>" }

Send one SIGNAL per tick on this channel. Stringify the JSON before passing it as the message parameter.
`.trim();

const APPROVALS_CHANNEL_HINT = `
Channel: "Trade Approvals" — executor proposes trades here, risk manager approves or rejects.

PROPOSE_TRADE (executor):
{ "type": "PROPOSE_TRADE", "from": "<your agent name>", "tokenIn": "UNI|USDC|WBTC", "tokenOut": "UNI|USDC|WBTC", "amountIn": "<amount>", "rationale": "<short reason>" }

DECISION (risk manager):
{ "type": "DECISION", "from": "<your agent name>", "verdict": "approve|reject", "reason": "<short reason>" }

Stringify the JSON before passing it as the message parameter.
`.trim();

const ALL_AGENT_IDS = Object.values(AGENT_IDS);

function buildAgents(userId: string): AgentConfig[] {
  const now = Date.now();

  const sentiment: AgentConfig = {
    id: AGENT_IDS.sentiment,
    userId,
    name: 'Sentiment Researcher',
    running: false,
    intervalMs: 60_000,
    dryRun: true,
    dryRunSeedBalances: { native: '100000000000000000' },
    allowedTokens: [
      UNI_ON_UNICHAIN.address.toLowerCase(),
      USDC_ON_UNICHAIN.address.toLowerCase(),
      WBTC_ON_UNICHAIN.address.toLowerCase(),
    ],
    riskLimits: { maxTradeUSD: 0, maxSlippageBps: 0 },
    toolIds: SENTIMENT_TOOL_IDS,
    connectedAgentIds: [],
    lastTickAt: null,
    createdAt: now,
    prompt: `You are the Sentiment Researcher. You read the market — prices, news, social signals — and publish trading signals for the executor agent. You never hold a wallet or execute trades.

${TOKEN_CONTEXT}

${SIGNALS_CHANNEL_HINT}

Every tick:
1. Use fetchTokenPriceUSD and fetchTokenInfoBySymbol to gather price snapshots for UNI and WBTC.
2. Use searchWeb and scrapeUrlMarkdown to gather recent news or social context that might move price (optional, only if memory suggests something is brewing).
3. Use readMemory / updateMemory / saveMemoryEntry to track your evolving view of each asset across ticks.
4. Publish exactly one SIGNAL message to the Trading Signals channel summarizing your current stance per asset (you may rotate between assets across ticks).`,
  };

  const risk: AgentConfig = {
    id: AGENT_IDS.risk,
    userId,
    name: 'Risk Manager',
    running: false,
    intervalMs: 60_000,
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
    prompt: `You are the Risk Manager. You sit between the sentiment researcher and the executor. You review proposed trades on the Trade Approvals channel and either approve or reject them. You can also message the executor directly to halt trading. You never execute trades yourself.

${TOKEN_CONTEXT}

${APPROVALS_CHANNEL_HINT}

Every tick:
1. Use getTokenBalance and fetchTokenPriceUSD to assess current exposure for the operator wallet.
2. Use readMemory / updateMemory / saveMemoryEntry to track your risk posture, recent decisions, and a running tally of approved vs rejected trades.
3. If the executor has posted PROPOSE_TRADE messages on the Trade Approvals channel since your last tick, review them — favor rejection when exposure is concentrated, drawdowns are large, or rationale is weak.
4. Post exactly one DECISION message per pending proposal you are responding to (or a single status DECISION if there is nothing to review).
5. If you want to halt all trading immediately, also send a sendMessageToAgent direct message to the Executor (use sendMessageToAgentHelp first to look up its UUID).`,
  };

  const executor: AgentConfig = {
    id: AGENT_IDS.executor,
    userId,
    name: 'Trade Executor',
    running: false,
    intervalMs: 60_000,
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
    prompt: `You are the Trade Executor. You consume signals from the Sentiment Researcher (via the Trading Signals channel), propose trades to the Risk Manager (via the Trade Approvals channel), and only execute swaps once you have an approval. You hold the wallet and the swap tools — but you must respect risk decisions.

${TOKEN_CONTEXT}

${SIGNALS_CHANNEL_HINT}

${APPROVALS_CHANNEL_HINT}

Every tick:
1. Use listAvailableChannels to find both channels by ID.
2. Use getTokenBalance and fetchTokenPriceUSD to know your current position and pricing.
3. Use readMemory / updateMemory to track latest signal, latest risk decision, and pending proposals.
4. If a fresh SIGNAL from the sentiment researcher suggests action and you do not already have a pending proposal, post one PROPOSE_TRADE on the Trade Approvals channel and wait — do not execute yet.
5. If you have an approved DECISION for a prior proposal, call getUniswapQuoteExactIn first to size and sanity-check the trade, then call executeUniswapSwapExactIn. Record the result in memory.
6. Never execute a swap that has not been explicitly approved by the Risk Manager.`,
  };

  return [sentiment, risk, executor];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log(`[seed-trading] seeding tokens, 3 trading agents, and 2 AXL channels for user ${SEED_USER_EMAIL}`);

    // --- tokens (full Coingecko catalog for chain + canonical overrides) ---
    await seedFullTokenCatalog(prisma);
    await upsertCanonicalTokens(prisma);

    // --- user ---
    const users = new PrismaUserRepository(prisma);
    const agents = new PrismaAgentRepository(prisma);

    const user = await users.findOrCreateByPrivyDid(SEED_USER_DID, { email: SEED_USER_EMAIL });
    console.log(`[seed-trading] user: ${user.id} (${user.email})`);

    // --- agents ---
    const agentConfigs = buildAgents(user.id);
    for (const cfg of agentConfigs) {
      await agents.upsert(cfg);
      console.log(`[seed-trading] upserted agent "${cfg.id}" — ${cfg.name} (${(cfg.toolIds ?? []).length} tools)`);
    }

    // --- agent-to-agent connections ---
    await agents.setAxlConnections(AGENT_IDS.executor, [AGENT_IDS.risk]);
    await agents.setAxlConnections(AGENT_IDS.risk, [AGENT_IDS.executor]);
    console.log(`[seed-trading] linked Executor ↔ Risk Manager for direct messaging`);

    // --- channels ---
    const existingChannels = await agents.listAxlChannelsByUser(user.id);
    const signalsExists = existingChannels.find((c) => c.name === 'Trading Signals');
    const approvalsExists = existingChannels.find((c) => c.name === 'Trade Approvals');

    if (!signalsExists) {
      const id = randomUUID();
      await agents.createAxlChannel({ id, userId: user.id, name: 'Trading Signals', createdAt: Date.now() });
      await agents.addAgentToAxlChannel(AGENT_IDS.sentiment, id);
      await agents.addAgentToAxlChannel(AGENT_IDS.executor, id);
      console.log(`[seed-trading] created channel "Trading Signals" with sentiment + executor`);
    } else {
      console.log(`[seed-trading] channel "Trading Signals" already exists — skipped`);
    }

    if (!approvalsExists) {
      const id = randomUUID();
      await agents.createAxlChannel({ id, userId: user.id, name: 'Trade Approvals', createdAt: Date.now() });
      await agents.addAgentToAxlChannel(AGENT_IDS.executor, id);
      await agents.addAgentToAxlChannel(AGENT_IDS.risk, id);
      console.log(`[seed-trading] created channel "Trade Approvals" with executor + risk`);
    } else {
      console.log(`[seed-trading] channel "Trade Approvals" already exists — skipped`);
    }

    console.log('[seed-trading] done. Run `npm run start:worker` to start the agent loop.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-trading] fatal:', err);
  process.exit(1);
});
