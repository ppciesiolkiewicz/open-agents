import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import { PrismaDatabase } from '../database/prisma-database/prisma-database';
import { getTestPrisma, truncateAll } from '../database/prisma-database/test-helpers';
import { UniswapService } from '../uniswap/uniswap-service';
import { DryRunWallet } from '../wallet/dry-run/dry-run-wallet';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../constants';
import type { AgentConfig } from '../database/types';
import type { AgentToolContext } from './tool';
import { createStubTickQueue } from '../test-lib/stub-tick-queue';

const TEST_KEY = '0x' + '11'.repeat(32);
const UNICHAIN_CHAIN_ID = 130;

function makeAgent(id: string, userId = 'user-placeholder'): AgentConfig {
  return {
    id,
    userId,
    name: id,
    running: true,
    intervalMs: 60_000,
    prompt: 'test',
    dryRun: true,
    dryRunSeedBalances: { native: '0', [USDC_ON_UNICHAIN.address]: '5000000' },
    allowedTokens: [USDC_ON_UNICHAIN.address],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: 0,
  };
}

describe('ToolRegistry tools (live, real services + postgres)', () => {
  const prisma = getTestPrisma();
  let registry: ToolRegistry;
  let agent: AgentConfig;
  let ctx: AgentToolContext;
  let db: PrismaDatabase;

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    await prisma.token.deleteMany({ where: { chainId: UNICHAIN_CHAIN_ID } });
    await prisma.token.createMany({
      data: [
        {
          chainId: UNICHAIN_CHAIN_ID,
          chain: 'unichain',
          address: USDC_ON_UNICHAIN.address.toLowerCase(),
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: 6,
          coingeckoId: 'usd-coin',
        },
        {
          chainId: UNICHAIN_CHAIN_ID,
          chain: 'unichain',
          address: UNI_ON_UNICHAIN.address.toLowerCase(),
          symbol: 'UNI',
          name: 'Uniswap',
          decimals: 18,
          coingeckoId: 'uniswap',
        },
      ],
    });
    db = new PrismaDatabase(prisma);
    const u = await db.users.findOrCreateByPrivyDid('did:privy:test', {});
    agent = makeAgent('a1', u.id);
    await db.agents.upsert(agent);
    const wallet = new DryRunWallet(agent, db.transactions, { WALLET_PRIVATE_KEY: TEST_KEY });
    ctx = { agent, wallet, tickId: 'tick-test-1' };
    registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: process.env.COINGECKO_API_KEY ?? 'dummy' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: process.env.COINMARKETCAP_API_KEY ?? 'dummy' }),
      serper: new SerperService({ apiKey: process.env.SERPER_API_KEY ?? 'dummy' }),
      firecrawl: new FirecrawlService({ apiKey: process.env.FIRECRAWL_API_KEY ?? 'dummy' }),
      db,
      uniswap: process.env.ALCHEMY_API_KEY
        ? new UniswapService({ ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY, UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL }, db)
        : ({} as UniswapService),
      env: {
        ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY ?? 'dummy',
        UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
      } as any,
      tickQueue: createStubTickQueue(),
    });
  });

  it('fetchTokenPriceUSD returns a sensible UNI price', async () => {
    const tool = registry.build().find((t) => t.name === 'fetchTokenPriceUSD');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ coingeckoId: 'uniswap' }, ctx)) as { price: number; currency: string; coingeckoId: string };
    console.log('[tool-registry] price:', result);
    expect(result.coingeckoId).toBe('uniswap');
    expect(result.price).toBeGreaterThan(0);
  });

  it('getWalletAddress returns the current agent wallet address', async () => {
    const tool = registry.build().find((t) => t.name === 'getWalletAddress');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({}, ctx)) as { address: string };
    console.log('[tool-registry] wallet address:', result);
    expect(result.address).toBe(ctx.wallet.getAddress());
  });

  it('getTokenBalance reflects the dry-run seed (USDC 5) with enriched shape', async () => {
    const tool = registry.build().find((t) => t.name === 'getTokenBalance');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ tokenAddress: USDC_ON_UNICHAIN.address }, ctx)) as {
      tokenAddress: string;
      raw: string;
      formatted: string;
      decimals: number;
      symbol: string;
    };
    console.log('[tool-registry] USDC balance:', result);
    expect(result.tokenAddress).toBe(USDC_ON_UNICHAIN.address.toLowerCase());
    expect(result.raw).toBe('5000000');
    expect(result.formatted).toBe('5');
    expect(result.decimals).toBe(6);
    expect(result.symbol).toBe('USDC');
  });

  it('updateMemory persists state and notes for the right agent', async () => {
    const tool = registry.build().find((t) => t.name === 'updateMemory');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ state: { foo: 1 }, appendNote: 'hello' }, ctx)) as { ok: boolean };
    console.log('[tool-registry] updateMemory:', result);
    expect(result.ok).toBe(true);
    const mem = await db.agentMemory.get(agent.id);
    expect(mem?.state).toEqual({ foo: 1 });
    expect(mem?.notes).toContain('hello');
  });

  it('saveMemoryEntry appends an entry; searchMemoryEntries finds it', async () => {
    const save = registry.build().find((t) => t.name === 'saveMemoryEntry');
    const search = registry.build().find((t) => t.name === 'searchMemoryEntries');
    if (!save || !search) throw new Error('memory tools missing');

    await save.invoke({ type: 'observation', content: 'UNI rallied to 7.42 USD' }, ctx);
    await save.invoke({ type: 'note', content: 'will buy on the next dip' }, ctx);

    const matches = (await search.invoke({ query: 'UNI' }, ctx)) as { matches: Array<{ content: string }> };
    console.log('[tool-registry] search matches:', matches);
    expect(matches.matches).toHaveLength(1);
    expect(matches.matches[0]!.content).toContain('UNI');

    const all = (await search.invoke({ query: 'on the' }, ctx)) as { matches: Array<{ content: string }> };
    expect(all.matches).toHaveLength(1);
    expect(all.matches[0]!.content).toContain('dip');
  });

  it('readMemory returns state, notes, and recent entries', async () => {
    const update = registry.build().find((t) => t.name === 'updateMemory');
    const save = registry.build().find((t) => t.name === 'saveMemoryEntry');
    const read = registry.build().find((t) => t.name === 'readMemory');
    if (!update || !save || !read) throw new Error('memory tools missing');

    await update.invoke({ state: { lastPrice: 7.42 }, appendNote: 'rally' }, ctx);
    await save.invoke({ type: 'snapshot', content: 'price=7.42' }, ctx);

    const result = (await read.invoke({}, ctx)) as {
      state: Record<string, unknown>;
      notes: string;
      recentEntries: Array<{ content: string }>;
    };
    console.log('[tool-registry] read result:', result);
    expect(result.state).toEqual({ lastPrice: 7.42 });
    expect(result.notes).toContain('rally');
    expect(result.recentEntries).toHaveLength(1);
    expect(result.recentEntries[0]!.content).toBe('price=7.42');
  });

  it('getUniswapQuoteExactIn returns a positive amountOut for 1 USDC → UNI', async () => {
    const tool = registry.build().find((t) => t.name === 'getUniswapQuoteExactIn');
    if (!tool) throw new Error('quote tool missing');
    const result = (await tool.invoke({
      tokenInAddress: USDC_ON_UNICHAIN.address,
      tokenOutAddress: UNI_ON_UNICHAIN.address,
      amountIn: '1',
    }, ctx)) as { amountOut: string; feeTier: number };
    console.log('[tool-registry] uniswap quote:', result);
    expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
    expect(result.feeTier).toBe(3_000);
  });
});
