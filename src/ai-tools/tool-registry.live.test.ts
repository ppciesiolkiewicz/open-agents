import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from './tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import { FileDatabase } from '../database/file-database/file-database';
import { UniswapService } from '../uniswap/uniswap-service';
import { DryRunWallet } from '../wallet/dry-run/dry-run-wallet';
import { TOKENS } from '../constants';
import type { AgentConfig } from '../database/types';
import type { AgentToolContext } from './tool';

const TEST_KEY = '0x' + '11'.repeat(32);
const COINGECKO = process.env.COINGECKO_API_KEY;

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: id,
    enabled: true,
    intervalMs: 60_000,
    prompt: 'test',
    walletAddress: '',
    dryRun: true,
    dryRunSeedBalances: { native: '0', [TOKENS.USDC.address]: '5000000' },
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: 0,
  };
}

describe('ToolRegistry tools (live, real services + fs)', () => {
  let dbDir: string;
  let registry: ToolRegistry;
  let agent: AgentConfig;
  let ctx: AgentToolContext;
  let db: FileDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-toolreg-'));
    db = new FileDatabase(dbDir);
    agent = makeAgent('a1');
    const wallet = new DryRunWallet(agent, db.transactions, { WALLET_PRIVATE_KEY: TEST_KEY });
    ctx = { agent, wallet, tickId: 'tick-test-1' };
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
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it.skipIf(!COINGECKO)('fetchTokenPriceUSD returns a sensible UNI price', async () => {
    const tool = registry.build().find((t) => t.name === 'fetchTokenPriceUSD');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ symbol: 'UNI' }, ctx)) as { symbol: string; priceUSD: number };
    console.log('[tool-registry] price:', result);
    expect(result.symbol).toBe('UNI');
    expect(result.priceUSD).toBeGreaterThan(0);
  });

  it('getTokenBalance reflects the dry-run seed (USDC 5)', async () => {
    const tool = registry.build().find((t) => t.name === 'getTokenBalance');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ tokenAddress: TOKENS.USDC.address }, ctx)) as { tokenAddress: string; raw: string };
    console.log('[tool-registry] USDC balance:', result);
    expect(result.tokenAddress).toBe(TOKENS.USDC.address);
    expect(result.raw).toBe('5000000');
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
});
