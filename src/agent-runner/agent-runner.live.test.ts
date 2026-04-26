import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDatabase } from '../database/file-database/file-database';
import { FileActivityLogStore } from '../agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import { WalletFactory } from '../wallet/factory/wallet-factory';
import { StubLLMClient } from './stub-llm-client';
import { AgentRunner, type Clock } from './agent-runner';
import type { LLMClient } from './llm-client';
import type { AgentConfig } from '../database/types';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = {
  WALLET_PRIVATE_KEY: TEST_KEY,
  ALCHEMY_API_KEY: 'unused',
};

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: `agent-${id}`,
    enabled: true,
    intervalMs: 60_000,
    prompt: `You are ${id}, a test agent. Decide what to do this tick.`,
    walletAddress: '',
    dryRun: true,
    dryRunSeedBalances: { native: '1000000000000000000' },
    riskLimits: { maxTradeUSD: 100 },
    lastTickAt: null,
    createdAt: 1000,
  };
}

describe('AgentRunner (live, real db + activity log)', () => {
  let dbDir: string;
  let db: FileDatabase;
  let activityLog: AgentActivityLog;
  let walletFactory: WalletFactory;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-runner-'));
    db = new FileDatabase(dbDir);
    activityLog = new AgentActivityLog(new FileActivityLogStore(dbDir));
    walletFactory = new WalletFactory(TEST_ENV, db.transactions);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('writes tick_start → llm_call → llm_response → tick_end and updates lastTickAt', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);
    const fixedClock: Clock = { now: () => 5_000 };

    const runner = new AgentRunner(db, activityLog, walletFactory, new StubLLMClient(), fixedClock);
    await runner.run(agent);

    const entries = await activityLog.list('a1');
    console.log('[runner] entries:', entries.map((e) => e.type));
    expect(entries.map((e) => e.type)).toEqual([
      'tick_start',
      'llm_call',
      'llm_response',
      'tick_end',
    ]);
    expect(entries.every((e) => e.tickId === 'a1-5000')).toBe(true);

    const reloaded = await db.agents.findById('a1');
    expect(reloaded?.lastTickAt).toBe(5_000);
  });

  it('logs prompt and response sizes on llm_call and llm_response', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);

    const runner = new AgentRunner(db, activityLog, walletFactory, new StubLLMClient());
    await runner.run(agent);

    const entries = await activityLog.list('a1');
    const llmCall = entries.find((e) => e.type === 'llm_call');
    const llmResponse = entries.find((e) => e.type === 'llm_response');
    console.log('[runner] llm sizes:', {
      promptChars: llmCall?.payload.promptChars,
      responseChars: llmResponse?.payload.responseChars,
    });
    expect(llmCall?.payload.model).toBe('stub');
    expect(typeof llmCall?.payload.promptChars).toBe('number');
    expect((llmCall!.payload.promptChars as number) > 0).toBe(true);
    expect(llmResponse?.payload.model).toBe('stub');
    expect((llmResponse!.payload.responseChars as number) > 0).toBe(true);
  });

  it('initializes empty memory for an agent that has none yet', async () => {
    const agent = makeAgent('fresh');
    await db.agents.upsert(agent);

    const runner = new AgentRunner(db, activityLog, walletFactory, new StubLLMClient());
    await runner.run(agent);

    // Memory is read inside run() but not written this slice. Verify get() still returns null.
    expect(await db.agentMemory.get('fresh')).toBeNull();
    // The tick still completed successfully.
    const entries = await activityLog.list('fresh');
    expect(entries.find((e) => e.type === 'tick_end')?.payload.ok).toBe(true);
  });

  it('on LLM failure, writes an error entry, still emits tick_end, still updates lastTickAt', async () => {
    const agent = makeAgent('boom');
    await db.agents.upsert(agent);
    const fixedClock: Clock = { now: () => 9_000 };

    class FailingLLM implements LLMClient {
      modelName() { return 'failing'; }
      async invoke(): Promise<never> {
        throw new Error('llm exploded');
      }
    }

    const runner = new AgentRunner(db, activityLog, walletFactory, new FailingLLM(), fixedClock);
    await expect(runner.run(agent)).resolves.toBeUndefined();  // does NOT rethrow

    const entries = await activityLog.list('boom');
    console.log('[runner] error path entries:', entries.map((e) => e.type));
    expect(entries.map((e) => e.type)).toEqual([
      'tick_start',
      'llm_call',
      'error',
      'tick_end',
    ]);
    expect(entries.find((e) => e.type === 'error')?.payload.message).toBe('llm exploded');
    expect(entries.find((e) => e.type === 'tick_end')?.payload.ok).toBe(false);

    const reloaded = await db.agents.findById('boom');
    expect(reloaded?.lastTickAt).toBe(9_000);
  });

  it('does not rethrow even when activity log itself fails on the error path', async () => {
    const agent = makeAgent('double-fail');
    await db.agents.upsert(agent);
    const fixedClock: Clock = { now: () => 12_000 };

    class AlwaysFailingLLM implements LLMClient {
      modelName() { return 'broken'; }
      async invoke(): Promise<never> { throw new Error('llm boom'); }
    }

    // Wrap activityLog so .error() also throws
    const realLog = activityLog;
    const brokenLog = new Proxy(realLog, {
      get(target, prop, receiver) {
        if (prop === 'error') {
          return async () => { throw new Error('log boom'); };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof activityLog;

    const runner = new AgentRunner(db, brokenLog, walletFactory, new AlwaysFailingLLM(), fixedClock);
    await expect(runner.run(agent)).resolves.toBeUndefined();  // does NOT rethrow

    // lastTickAt still updates in finally
    const reloaded = await db.agents.findById('double-fail');
    expect(reloaded?.lastTickAt).toBe(12_000);
  });

  it('uses cached wallet from WalletFactory across two ticks of the same agent', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);
    const runner = new AgentRunner(db, activityLog, walletFactory, new StubLLMClient());

    await runner.run(agent);
    const wallet1 = walletFactory.forAgent(agent);
    await runner.run(agent);
    const wallet2 = walletFactory.forAgent(agent);

    expect(wallet1).toBe(wallet2);  // cache returned same instance
  });
});
