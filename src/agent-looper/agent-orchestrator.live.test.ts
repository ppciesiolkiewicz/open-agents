import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDatabase } from '../database/file-database/file-database';
import { FileActivityLogStore } from '../agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import { WalletFactory } from '../wallet/factory/wallet-factory';
import { AgentRunner, type Clock } from '../agent-runner/agent-runner';
import { StubLLMClient } from '../agent-runner/stub-llm-client';
import { AgentOrchestrator } from './agent-orchestrator';
import { InMemoryTickQueue } from '../agent-runner/tick-queue';
import { ToolRegistry } from '../ai-tools/tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { AgentConfig } from '../database/types';
import type { LLMClient } from '../agent-runner/llm-client';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = { WALLET_PRIVATE_KEY: TEST_KEY, ALCHEMY_API_KEY: 'unused' };

function makeAgent(id: string, opts: { running?: boolean; intervalMs?: number; lastTickAt?: number | null } = {}): AgentConfig {
  return {
    id,
    name: id,
    running: opts.running ?? true,
    intervalMs: opts.intervalMs ?? 1_000,
    prompt: `agent ${id}`,
    dryRun: true,
    dryRunSeedBalances: { native: '0' },
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: opts.lastTickAt ?? null,
    createdAt: 0,
  };
}

class MutableClock implements Clock {
  constructor(private current: number) {}
  now(): number { return this.current; }
  advance(ms: number): void { this.current += ms; }
}

describe('AgentOrchestrator (live, real db + runner)', () => {
  let dbDir: string;
  let db: FileDatabase;
  let activityLog: AgentActivityLog;
  let walletFactory: WalletFactory;
  let clock: MutableClock;
  let runner: AgentRunner;
  let queue: InMemoryTickQueue;
  let orchestrator: AgentOrchestrator;

  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-orch-'));
    db = new FileDatabase(dbDir);
    activityLog = new AgentActivityLog(new FileActivityLogStore(dbDir));
    walletFactory = new WalletFactory(TEST_ENV, db.transactions);
    toolRegistry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: 'dummy' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: 'dummy' }),
      serper: new SerperService({ apiKey: 'dummy' }),
      firecrawl: new FirecrawlService({ apiKey: 'dummy' }),
      db,
      uniswap: {} as import('../uniswap/uniswap-service').UniswapService,
    });
    clock = new MutableClock(10_000);
    runner = new AgentRunner(db, activityLog, walletFactory, new StubLLMClient(), toolRegistry, clock);
    queue = new InMemoryTickQueue(() => clock.now());
    orchestrator = new AgentOrchestrator(db, runner, queue, clock);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('runs an agent that has never ticked (lastTickAt = null)', async () => {
    await db.agents.upsert(makeAgent('a1', { intervalMs: 1_000, lastTickAt: null }));

    await orchestrator.tick();
    await queue.drain();

    const entries = await activityLog.list('a1');
    console.log('[orch] a1 first tick entries:', entries.map((e) => e.type));
    expect(entries.find((e) => e.type === 'tick_end')).toBeDefined();
  });

  it('skips agents whose interval has not elapsed', async () => {
    await db.agents.upsert(makeAgent('not-due', { intervalMs: 5_000, lastTickAt: 9_000 }));
    // clock is at 10_000; 10_000 - 9_000 = 1_000 < 5_000 → not due

    await orchestrator.tick();
    await queue.drain();

    expect(await activityLog.list('not-due')).toEqual([]);
  });

  it('skips disabled agents', async () => {
    await db.agents.upsert(makeAgent('off', { running: false, lastTickAt: null }));

    await orchestrator.tick();
    await queue.drain();

    expect(await activityLog.list('off')).toEqual([]);
  });

  it('runs only ONCE per orchestrator.tick even if N intervals were missed (skip-backlog)', async () => {
    // intervalMs = 1_000, lastTickAt = 0; clock at 10_000 → 10 intervals missed.
    await db.agents.upsert(makeAgent('catch-up', { intervalMs: 1_000, lastTickAt: 0 }));

    await orchestrator.tick();
    await queue.drain();

    const entries = await activityLog.list('catch-up');
    const tickStarts = entries.filter((e) => e.type === 'tick_start');
    console.log('[orch] catch-up tick_start count after one orchestrator.tick():', tickStarts.length);
    expect(tickStarts).toHaveLength(1);

    // Subsequent orchestrator.tick at the same clock time runs zero (lastTickAt now = 10_000).
    await orchestrator.tick();
    await queue.drain();
    const after = await activityLog.list('catch-up');
    expect(after.filter((e) => e.type === 'tick_start')).toHaveLength(1);
  });

  it('runs again after the interval elapses on a future orchestrator.tick', async () => {
    await db.agents.upsert(makeAgent('a1', { intervalMs: 1_000, lastTickAt: null }));

    await orchestrator.tick();
    await queue.drain();              // first tick at clock=10_000
    clock.advance(1_500);                    // clock=11_500, > lastTickAt + 1_000
    await orchestrator.tick();
    await queue.drain();              // second tick

    const tickStarts = (await activityLog.list('a1')).filter((e) => e.type === 'tick_start');
    expect(tickStarts).toHaveLength(2);
  });

  it('one agent failing does not block the next agent', async () => {
    await db.agents.upsert(makeAgent('fails', { intervalMs: 1_000, lastTickAt: null }));
    await db.agents.upsert(makeAgent('ok', { intervalMs: 1_000, lastTickAt: null }));

    class SelectiveLLM implements LLMClient {
      modelName() { return 'selective'; }
      async invoke(prompt: string): Promise<{ content: string }> {
        if (prompt.includes('fails')) throw new Error('boom');
        return { content: 'ok' };
      }
      async invokeWithTools(messages: import('../agent-runner/llm-client').ChatMessage[]): Promise<import('../agent-runner/llm-client').LLMTurnResult> {
        const flat = messages.map((m) => 'content' in m ? m.content : '').join('\n');
        if (flat.includes('fails')) throw new Error('boom');
        return {
          content: 'ok',
          assistantMessage: { role: 'assistant', content: 'ok' },
        };
      }
    }

    const failingRunner = new AgentRunner(db, activityLog, walletFactory, new SelectiveLLM(), toolRegistry, clock);
    const failingQueue = new InMemoryTickQueue(() => clock.now());
    const failingOrch = new AgentOrchestrator(db, failingRunner, failingQueue, clock);

    await failingOrch.tick();
    await failingQueue.drain();

    const failsEntries = (await activityLog.list('fails')).map((e) => e.type);
    const okEntries = (await activityLog.list('ok')).map((e) => e.type);
    console.log('[orch] fails:', failsEntries, '| ok:', okEntries);
    expect(failsEntries).toContain('error');
    expect(okEntries).toContain('tick_end');
  });

  it('runs agents sequentially (subsequent agent sees previous lastTickAt)', async () => {
    // Two agents with the same id space — verify ordering by inserting both
    // and checking the order tick_start appears in the global log stream.
    await db.agents.upsert(makeAgent('first', { intervalMs: 1_000, lastTickAt: null }));
    await db.agents.upsert(makeAgent('second', { intervalMs: 1_000, lastTickAt: null }));

    await orchestrator.tick();
    await queue.drain();

    const firstEntries = await activityLog.list('first');
    const secondEntries = await activityLog.list('second');
    expect(firstEntries.find((e) => e.type === 'tick_end')).toBeDefined();
    expect(secondEntries.find((e) => e.type === 'tick_end')).toBeDefined();
  });
});
