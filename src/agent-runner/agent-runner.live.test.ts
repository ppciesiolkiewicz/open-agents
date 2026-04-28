import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDatabase } from '../database/file-database/file-database';
import { FileActivityLogStore } from '../agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import { WalletFactory } from '../wallet/factory/wallet-factory';
import { ToolRegistry } from '../ai-tools/tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import { AgentRunner, type Clock } from './agent-runner';
import type {
  ChatMessage,
  LLMClient,
  LLMResponse,
  LLMTurnResult,
  ToolDefinition,
} from './llm-client';
import type { AgentConfig } from '../database/types';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = { WALLET_PRIVATE_KEY: TEST_KEY, ALCHEMY_API_KEY: 'unused' };

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: `agent-${id}`,
    running: true,
    intervalMs: 60_000,
    prompt: `You are ${id}. Respond briefly.`,
    dryRun: true,
    dryRunSeedBalances: { native: '1000000000000000000' },
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: 1000,
  };
}

// Minimal scripted client. Each call to invokeWithTools consumes one step.
type ScriptStep =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; toolName: string; argsJson: string }
  | { kind: 'throw'; message: string };

class ScriptedLLMClient implements LLMClient {
  private readonly script: ScriptStep[];
  private callCount = 0;

  constructor(script: ScriptStep[]) {
    this.script = [...script];
  }

  modelName(): string {
    return 'scripted';
  }

  async invoke(prompt: string): Promise<LLMResponse> {
    return { content: `[scripted] ${prompt.slice(0, 40)}` };
  }

  async invokeWithTools(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<LLMTurnResult> {
    this.callCount++;
    const step = this.script.shift();
    if (!step) throw new Error('ScriptedLLMClient: script exhausted at call ' + this.callCount);

    if (step.kind === 'throw') throw new Error(step.message);

    if (step.kind === 'tool') {
      const id = `call-${this.callCount}`;
      return {
        toolCalls: [{ id, name: step.toolName, argumentsJson: step.argsJson }],
        assistantMessage: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id, name: step.toolName, argumentsJson: step.argsJson }],
        },
      };
    }

    return {
      content: step.content,
      assistantMessage: { role: 'assistant', content: step.content },
    };
  }
}

describe('AgentRunner (live, real db + activity log + ToolRegistry)', () => {
  let dbDir: string;
  let db: FileDatabase;
  let activityLog: AgentActivityLog;
  let walletFactory: WalletFactory;
  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-runner-'));
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
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('writes tick_start, llm_call, llm_response, tick_end and updates lastTickAt (no tool calls)', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);
    const fixedClock: Clock = { now: () => 5_000 };
    const llm = new ScriptedLLMClient([{ kind: 'text', content: 'hello there' }]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry, fixedClock);

    await runner.run(agent);

    const types = (await activityLog.list('a1')).map((e) => e.type);
    console.log('[runner] entries:', types);
    expect(types).not.toContain('user_message');
    expect(types[0]).toBe('tick_start');
    expect(types).toContain('llm_call');
    expect(types).toContain('llm_response');
    expect(types[types.length - 1]).toBe('tick_end');

    const reloaded = await db.agents.findById('a1');
    expect(reloaded?.lastTickAt).toBe(5_000);
  });

  it('captures tool_call + tool_result entries when the model emits a tool call', async () => {
    const agent = makeAgent('a-tools');
    await db.agents.upsert(agent);

    const llm = new ScriptedLLMClient([
      { kind: 'tool', toolName: 'updateMemory', argsJson: JSON.stringify({ appendNote: 'first thought' }) },
      { kind: 'text', content: 'done' },
    ]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

    await runner.run(agent);

    const types = (await activityLog.list('a-tools')).map((e) => e.type);
    console.log('[runner] tool-loop entries:', types);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('tick_end');

    const mem = await db.agentMemory.get('a-tools');
    expect(mem?.notes).toContain('first thought');
  });

  it('rethrows when the LLM throws, and still updates lastTickAt + writes error entry', async () => {
    const agent = makeAgent('boom');
    await db.agents.upsert(agent);
    const fixedClock: Clock = { now: () => 9_000 };

    const llm = new ScriptedLLMClient([{ kind: 'throw', message: 'llm exploded' }]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry, fixedClock);
    await expect(runner.run(agent)).rejects.toThrow('llm exploded');

    const types = (await activityLog.list('boom')).map((e) => e.type);
    console.log('[runner] error path:', types);
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('tick_end');

    const reloaded = await db.agents.findById('boom');
    expect(reloaded?.lastTickAt).toBe(9_000);
  });

  it('returns a tool-error message (not a thrown rejection) when a tool throws', async () => {
    const agent = makeAgent('tool-bad');
    await db.agents.upsert(agent);

    // Bad tokenAddress triggers the wallet-balance tool to throw.
    const llm = new ScriptedLLMClient([
      { kind: 'tool', toolName: 'getTokenBalance', argsJson: JSON.stringify({ tokenAddress: 'not-an-address' }) },
      { kind: 'text', content: 'recovered' },
    ]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

    await runner.run(agent);

    const entries = await activityLog.list('tool-bad');
    const types = entries.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('tick_end');

    const toolResult = entries.find((e) => e.type === 'tool_result');
    console.log('[runner] tool error result:', toolResult?.payload);
    expect(String(toolResult?.payload.output)).toContain('error:');
  });

  it('caps the loop at maxToolRoundsPerTick when the model only returns tool calls', async () => {
    const agent = makeAgent('runaway');
    await db.agents.upsert(agent);

    // Always return a tool call — never plain text. Provide 12 steps so we
    // hit the cap of 10 first.
    const stepsCount = 12;
    const script = Array.from({ length: stepsCount }, () => ({
      kind: 'tool' as const,
      toolName: 'readMemory',
      argsJson: '{}',
    }));
    const llm = new ScriptedLLMClient(script);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

    await runner.run(agent);

    const entries = await activityLog.list('runaway');
    const errorEntry = entries.find((e) => e.type === 'error');
    expect(errorEntry?.payload.message).toMatch(/exceeded \d+ tool-call rounds/);
    expect(entries[entries.length - 1]?.type).toBe('tick_end');
  });
});
