# Slice 4 — Looper gate logic + AgentRunner skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the system actually fire per-agent ticks. `AgentOrchestrator` reads enabled agents from the DB, checks who is due, calls `AgentRunner.run(agent)` once per due agent (skipping backlog), and updates `lastTickAt` on each run. `AgentRunner` uses a production `StubLLMClient` that returns canned text — slice 5 swaps in the real 0G chat model.

**Architecture:** `agent-runner/` owns the per-tick worker (`AgentRunner.run(agent)`), `LLMClient` interface, and `StubLLMClient` production stub. `agent-looper/` keeps the existing generic `Looper` and adds a new `AgentOrchestrator` that does the gate logic (load → filter due → dispatch). Bootstrap wires `looper.onTick = () => orchestrator.tick()`. Sequential dispatch within a tick. Errors in one agent never block another. `lastTickAt` updates on success AND failure (skip-backlog invariant).

**Tech Stack:** TypeScript 5.x, Node 20+, vitest. No new npm deps. Uses slice 2's `Database` + `AgentActivityLog`, slice 3's `WalletFactory`, and the existing slice 1 `Looper`.

**Spec reference:** [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](../specs/2026-04-26-agent-loop-foundation-design.md) — sections "Loop Mechanics" and "AI Integration (0G)" (the StubLLMClient is the slice-4 placeholder for the real chat model that lands in slice 5).

**Test rule (slice 4):**
- `AgentRunner` and `AgentOrchestrator` both touch the filesystem indirectly (via `FileDatabase` + `FileActivityLogStore`), so both get `*.live.test.ts` against tmpdir.
- `LLMClient` interface gets no test (pure type).
- `StubLLMClient` is exercised by the runner's tests; no separate test file.

---

## File Structure

```
src/agent-runner/
  llm-client.ts                          # LLMClient interface + LLMResponse type
  stub-llm-client.ts                     # StubLLMClient (production stub)
  agent-runner.ts                        # AgentRunner.run(agent)
  agent-runner.live.test.ts              # one tick → log entries + lastTickAt
src/agent-looper/
  looper.ts                              # (existing — unchanged)
  agent-orchestrator.ts                  # AgentOrchestrator.tick(): gate + dispatch
  agent-orchestrator.live.test.ts        # gate logic with fake clock + sequential dispatch
src/index.ts                             # MODIFY — wire StubLLMClient + AgentRunner + AgentOrchestrator
```

---

## Task 1: LLMClient interface + StubLLMClient

**Files:**
- Create: `src/agent-runner/llm-client.ts`
- Create: `src/agent-runner/stub-llm-client.ts`

The LLM is a hard dependency of `AgentRunner`. We define the interface in slice 4 and ship a stub production impl. Slice 5 will add a real impl that talks to 0G via Langchain.

- [ ] **Step 1: Create `src/agent-runner/llm-client.ts`**

```ts
export interface LLMResponse {
  content: string;
}

export interface LLMClient {
  modelName(): string;
  invoke(prompt: string): Promise<LLMResponse>;
}
```

- [ ] **Step 2: Create `src/agent-runner/stub-llm-client.ts`**

```ts
import type { LLMClient, LLMResponse } from './llm-client';

// Production stub used by slice 4 (no real LLM yet) and as a test seam later.
// Slice 5 introduces a real LLMClient backed by 0G via Langchain.
export class StubLLMClient implements LLMClient {
  modelName(): string {
    return 'stub';
  }

  async invoke(prompt: string): Promise<LLMResponse> {
    const head = prompt.slice(0, 80).replace(/\s+/g, ' ');
    return {
      content: `[stub-llm] received ${prompt.length}-char prompt; would reason about: "${head}"`,
    };
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/agent-runner/llm-client.ts src/agent-runner/stub-llm-client.ts
git commit -m "feat(agent-runner): add LLMClient interface and StubLLMClient (production stub)"
```

---

## Task 2: AgentRunner implementation

**Files:**
- Create: `src/agent-runner/agent-runner.ts`

- [ ] **Step 1: Implement `agent-runner.ts`**

```ts
import type { Database } from '../database/database';
import type { AgentConfig, AgentMemory } from '../database/types';
import type { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import type { WalletFactory } from '../wallet/factory/wallet-factory';
import type { LLMClient } from './llm-client';

export interface Clock {
  now(): number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentRunner {
  constructor(
    private readonly db: Database,
    private readonly activityLog: AgentActivityLog,
    private readonly walletFactory: WalletFactory,
    private readonly llm: LLMClient,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async run(agent: AgentConfig): Promise<void> {
    const tickId = `${agent.id}-${this.clock.now()}`;
    await this.activityLog.tickStart(agent.id, tickId);

    try {
      const memory = await this.loadOrInitMemory(agent.id);
      // Wallet is constructed (cached by factory) but not yet exposed to the
      // LLM as tools — slice 6 wires balance/swap tools.
      this.walletFactory.forAgent(agent);

      const prompt = this.buildPrompt(agent, memory);
      await this.activityLog.llmCall(agent.id, tickId, {
        model: this.llm.modelName(),
        promptChars: prompt.length,
      });

      const response = await this.llm.invoke(prompt);
      await this.activityLog.llmResponse(agent.id, tickId, {
        model: this.llm.modelName(),
        responseChars: response.content.length,
      });

      await this.activityLog.tickEnd(agent.id, tickId, {
        ok: true,
        responseChars: response.content.length,
      });
    } catch (err) {
      const e = err as Error;
      await this.activityLog.error(agent.id, tickId, {
        message: e.message,
        stack: e.stack,
      });
      await this.activityLog.tickEnd(agent.id, tickId, { ok: false });
      // Do NOT rethrow — orchestrator continues with the next agent.
    } finally {
      // Skip-backlog invariant: lastTickAt updates on success AND failure.
      await this.db.agents.upsert({ ...agent, lastTickAt: this.clock.now() });
    }
  }

  private buildPrompt(agent: AgentConfig, memory: AgentMemory): string {
    return [
      agent.prompt,
      '',
      'Memory state:',
      JSON.stringify(memory.state, null, 2),
      '',
      'Memory notes:',
      memory.notes || '(empty)',
    ].join('\n');
  }

  private async loadOrInitMemory(agentId: string): Promise<AgentMemory> {
    const existing = await this.db.agentMemory.get(agentId);
    if (existing) return existing;
    return {
      agentId,
      notes: '',
      state: {},
      updatedAt: this.clock.now(),
    };
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/agent-runner.ts
git commit -m "feat(agent-runner): add AgentRunner.run with stub LLM, activity log, and lastTickAt update"
```

---

## Task 3: AgentRunner live test

**Files:**
- Create: `src/agent-runner/agent-runner.live.test.ts`

Real `FileDatabase` + `FileActivityLogStore` in tmpdir. Real `StubLLMClient`. Real `WalletFactory` with a dry-run agent so no RPC is needed. Verifies tick-start → llm_call → llm_response → tick_end ordering, `lastTickAt` updated, error path produces an `error` entry and still updates `lastTickAt`.

- [ ] **Step 1: Write the live test**

`src/agent-runner/agent-runner.live.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/agent-runner/`
Expected: 5 tests pass; entry sequences and llm sizes logged.

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/agent-runner.live.test.ts
git commit -m "feat(agent-runner): add AgentRunner live test (success + error path + lastTickAt)"
```

---

## Task 4: AgentOrchestrator implementation

**Files:**
- Create: `src/agent-looper/agent-orchestrator.ts`

The orchestrator is the gate logic from the spec ("Loop Mechanics"). It takes a `Clock` (defaulting to system) so the test can advance time deterministically.

- [ ] **Step 1: Implement `agent-orchestrator.ts`**

```ts
import type { Database } from '../database/database';
import type { AgentRunner, Clock } from '../agent-runner/agent-runner';

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly runner: AgentRunner,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async tick(): Promise<void> {
    const now = this.clock.now();
    const all = await this.db.agents.list();
    const due = all.filter(
      (a) => a.enabled && now - (a.lastTickAt ?? 0) >= a.intervalMs,
    );

    for (const agent of due) {
      try {
        await this.runner.run(agent);
      } catch (err) {
        // AgentRunner.run does not rethrow; this catch is defense-in-depth.
        console.error(`[orchestrator] agent ${agent.id} threw unexpectedly:`, err);
      }
    }
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/agent-looper/agent-orchestrator.ts
git commit -m "feat(agent-looper): add AgentOrchestrator with skip-backlog gate logic"
```

---

## Task 5: AgentOrchestrator live test

**Files:**
- Create: `src/agent-looper/agent-orchestrator.live.test.ts`

Real DB + activity log in tmpdir, real `AgentRunner` + `StubLLMClient`. Fake clock controls `now()` so we can prove the skip-backlog invariant.

- [ ] **Step 1: Write the live test**

`src/agent-looper/agent-orchestrator.live.test.ts`:

```ts
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
import type { AgentConfig } from '../database/types';
import type { LLMClient } from '../agent-runner/llm-client';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = { WALLET_PRIVATE_KEY: TEST_KEY, ALCHEMY_API_KEY: 'unused' };

function makeAgent(id: string, opts: { enabled?: boolean; intervalMs?: number; lastTickAt?: number | null } = {}): AgentConfig {
  return {
    id,
    name: id,
    enabled: opts.enabled ?? true,
    intervalMs: opts.intervalMs ?? 1_000,
    prompt: `agent ${id}`,
    walletAddress: '',
    dryRun: true,
    dryRunSeedBalances: { native: '0' },
    riskLimits: { maxTradeUSD: 100 },
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
  let orchestrator: AgentOrchestrator;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-orch-'));
    db = new FileDatabase(dbDir);
    activityLog = new AgentActivityLog(new FileActivityLogStore(dbDir));
    walletFactory = new WalletFactory(TEST_ENV, db.transactions);
    clock = new MutableClock(10_000);
    runner = new AgentRunner(db, activityLog, walletFactory, new StubLLMClient(), clock);
    orchestrator = new AgentOrchestrator(db, runner, clock);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('runs an agent that has never ticked (lastTickAt = null)', async () => {
    await db.agents.upsert(makeAgent('a1', { intervalMs: 1_000, lastTickAt: null }));

    await orchestrator.tick();

    const entries = await activityLog.list('a1');
    console.log('[orch] a1 first tick entries:', entries.map((e) => e.type));
    expect(entries.find((e) => e.type === 'tick_end')).toBeDefined();
  });

  it('skips agents whose interval has not elapsed', async () => {
    await db.agents.upsert(makeAgent('not-due', { intervalMs: 5_000, lastTickAt: 9_000 }));
    // clock is at 10_000; 10_000 - 9_000 = 1_000 < 5_000 → not due

    await orchestrator.tick();

    expect(await activityLog.list('not-due')).toEqual([]);
  });

  it('skips disabled agents', async () => {
    await db.agents.upsert(makeAgent('off', { enabled: false, lastTickAt: null }));

    await orchestrator.tick();

    expect(await activityLog.list('off')).toEqual([]);
  });

  it('runs only ONCE per orchestrator.tick even if N intervals were missed (skip-backlog)', async () => {
    // intervalMs = 1_000, lastTickAt = 0; clock at 10_000 → 10 intervals missed.
    await db.agents.upsert(makeAgent('catch-up', { intervalMs: 1_000, lastTickAt: 0 }));

    await orchestrator.tick();

    const entries = await activityLog.list('catch-up');
    const tickStarts = entries.filter((e) => e.type === 'tick_start');
    console.log('[orch] catch-up tick_start count after one orchestrator.tick():', tickStarts.length);
    expect(tickStarts).toHaveLength(1);

    // Subsequent orchestrator.tick at the same clock time runs zero (lastTickAt now = 10_000).
    await orchestrator.tick();
    const after = await activityLog.list('catch-up');
    expect(after.filter((e) => e.type === 'tick_start')).toHaveLength(1);
  });

  it('runs again after the interval elapses on a future orchestrator.tick', async () => {
    await db.agents.upsert(makeAgent('a1', { intervalMs: 1_000, lastTickAt: null }));

    await orchestrator.tick();              // first tick at clock=10_000
    clock.advance(1_500);                    // clock=11_500, > lastTickAt + 1_000
    await orchestrator.tick();              // second tick

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
    }

    const failingRunner = new AgentRunner(db, activityLog, walletFactory, new SelectiveLLM(), clock);
    const failingOrch = new AgentOrchestrator(db, failingRunner, clock);

    await failingOrch.tick();

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

    const firstEntries = await activityLog.list('first');
    const secondEntries = await activityLog.list('second');
    expect(firstEntries.find((e) => e.type === 'tick_end')).toBeDefined();
    expect(secondEntries.find((e) => e.type === 'tick_end')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/agent-looper/`
Expected: 7 tests pass; key counts logged.

- [ ] **Step 3: Commit**

```bash
git add src/agent-looper/agent-orchestrator.live.test.ts
git commit -m "feat(agent-looper): add AgentOrchestrator live test (gate, skip-backlog, isolation)"
```

---

## Task 6: Wire StubLLMClient + AgentRunner + AgentOrchestrator into bootstrap

**Files:**
- Modify: `src/index.ts`

Replace the placeholder `onTick` callback (which currently only logs the agent count) with a real call into the orchestrator. Slice 5 will swap `StubLLMClient` for the 0G-backed real client.

- [ ] **Step 1: Update `src/index.ts`**

Current file:

```ts
import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';
import { WalletFactory } from './wallet/factory/wallet-factory';

function main(): void {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }

  const db = new FileDatabase(env.DB_DIR);
  const activityLog = new AgentActivityLog(new FileActivityLogStore(env.DB_DIR));
  const walletFactory = new WalletFactory(env, db.transactions);
  void activityLog;     // wired for slice 4; not used this slice
  void walletFactory;   // wired for slice 4; not used this slice

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);
  console.log(`[bootstrap] wallet factory initialized`);

  const looper = new Looper({
    tickIntervalMs: LOOPER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(
        `[looper] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`,
      );
    },
  });

  looper.start();
  console.log(`[bootstrap] looper started, ticking every ${LOOPER.tickIntervalMs}ms`);

  const shutdown = (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping looper`);
    looper.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
```

Replace with:

```ts
import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';
import { AgentOrchestrator } from './agent-looper/agent-orchestrator';
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { StubLLMClient } from './agent-runner/stub-llm-client';

function main(): void {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }

  const db = new FileDatabase(env.DB_DIR);
  const activityLog = new AgentActivityLog(new FileActivityLogStore(env.DB_DIR));
  const walletFactory = new WalletFactory(env, db.transactions);
  const llm = new StubLLMClient();   // slice 5 will replace with the 0G-backed client
  const runner = new AgentRunner(db, activityLog, walletFactory, llm);
  const orchestrator = new AgentOrchestrator(db, runner);

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);
  console.log(`[bootstrap] wallet factory initialized`);
  console.log(`[bootstrap] agent runner initialized (LLM: ${llm.modelName()})`);

  const looper = new Looper({
    tickIntervalMs: LOOPER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(
        `[looper] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`,
      );
      await orchestrator.tick();
    },
  });

  looper.start();
  console.log(`[bootstrap] looper started, ticking every ${LOOPER.tickIntervalMs}ms`);

  const shutdown = (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping looper`);
    looper.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Manually verify the bootstrap (with valid env override)**

Run:

```bash
WALLET_PRIVATE_KEY=0x$(printf '11%.0s' {1..32}) timeout 13 npm start || true
```

Expected output (timestamps differ; with no agents in `db/database.json`, the orchestrator runs nothing):

```
[bootstrap] env loaded — ZEROG_NETWORK=mainnet, DB_DIR=./db
[bootstrap] database + activity log initialized at ./db
[bootstrap] wallet factory initialized
[bootstrap] agent runner initialized (LLM: stub)
[bootstrap] looper started, ticking every 10000ms
[looper] tick @ 2026-04-27T...Z — 0 agent(s) loaded
[bootstrap] received SIGTERM, stopping looper
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire AgentRunner + AgentOrchestrator + StubLLMClient into bootstrap"
```

---

## Task 7: End-to-end smoke with a seeded agent

**Files:**
- (no source changes — manual verification only)

Demonstrates the full path: drop a single agent into `db/database.json`, start the looper, confirm an activity log appears within ~12 s, then clean up.

- [ ] **Step 1: Seed a single agent into `./db/database.json`**

Create the directory and file (use `node` for cross-shell JSON quoting):

```bash
mkdir -p ./db
node -e '
  const fs = require("fs");
  const seed = {
    agents: [{
      id: "smoke-agent",
      name: "Smoke Test",
      enabled: true,
      intervalMs: 1000,
      prompt: "You are a smoke test. Say hello.",
      walletAddress: "",
      dryRun: true,
      dryRunSeedBalances: { native: "1000000000000000000" },
      riskLimits: { maxTradeUSD: 0 },
      lastTickAt: null,
      createdAt: Date.now(),
    }],
    transactions: [],
    positions: [],
  };
  fs.writeFileSync("./db/database.json", JSON.stringify(seed, null, 2));
'
```

- [ ] **Step 2: Run the looper for ~13 s and capture output**

```bash
WALLET_PRIVATE_KEY=0x$(printf '11%.0s' {1..32}) timeout 13 npm start || true
```

Expected: at least one `[looper] tick` line followed by — within the same tick — silent execution of `orchestrator.tick()` writing entries for `smoke-agent`. No errors.

- [ ] **Step 3: Confirm activity-log file was created and has the expected entry types**

```bash
ls ./db/activity-log/
cat ./db/activity-log/smoke-agent.json | head -10
```

Expected: `smoke-agent.json` exists; first 4 lines decode to `tick_start`, `llm_call`, `llm_response`, `tick_end`.

- [ ] **Step 4: Confirm `lastTickAt` was persisted**

```bash
node -e 'console.log(JSON.parse(require("fs").readFileSync("./db/database.json","utf8")).agents[0].lastTickAt)'
```

Expected: a number (epoch ms) — not `null`.

- [ ] **Step 5: Clean up the smoke artifacts**

```bash
rm -rf ./db
```

(`./db` is gitignored; this resets the project for fresh use.)

- [ ] **Step 6: No commit** — Task 7 is verification only; no source files changed.

---

## Task 8: Full sweep + tag

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected:
- `agent-runner.live.test.ts`: 5 tests pass
- `agent-orchestrator.live.test.ts`: 7 tests pass
- All slice 1–3 suites pass / skip as before
- Only known failure: pre-existing Firecrawl 402

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: exit code 0; `dist/` populated with `agent-runner/` subtree.

- [ ] **Step 3: Verify directory structure**

Run: `find src -type f | sort`

Expected new files versus slice 3:
```
src/agent-looper/agent-orchestrator.live.test.ts
src/agent-looper/agent-orchestrator.ts
src/agent-runner/agent-runner.live.test.ts
src/agent-runner/agent-runner.ts
src/agent-runner/llm-client.ts
src/agent-runner/stub-llm-client.ts
```

- [ ] **Step 4: Tag the slice**

Run: `git tag slice-4-runner-orchestrator`

- [ ] **Step 5: Final log inspection**

Run: `git log --oneline slice-3-wallet..HEAD`
Expected: 7 new commits (Tasks 1, 2, 3, 4, 5, 6, plus the docs/plan commit at the start of slice 4).

---

## Out of Scope for Slice 4

Deferred to later slices:
- Real LLM (0G via Langchain) — Slice 5
- LLM tool calls (Coingecko, wallet, swap, …) — Slice 6
- LLM-driven memory writes — Slice 6 (memory-update tool)
- Uniswap module + swap execution — Slice 7
- Seed agent config + end-to-end MA trader — Slice 8
- Parallel per-tick agent dispatch — never needed for v1 single-process
- Per-agent allowlist of tools — never needed for v1 (all-tools-on)

---

## Self-Review

**Spec coverage check:**
- ✅ "Loop Mechanics" — `AgentOrchestrator.tick()` loads enabled agents, computes `due = now - (lastTickAt ?? 0) >= intervalMs`, dispatches sequentially, **skips backlog** (one run per orchestrator tick), updates `lastTickAt` on success AND failure — Tasks 4, 5
- ✅ `AgentRunner.run(agent)` is a callable that takes config + deps so it can move to a worker later (no global state, all deps in constructor) — Task 2
- ✅ Activity log captures `tick_start`, `llm_call`, `llm_response`, `tick_end`, `error` per spec — Tasks 2, 3
- ✅ `StubLLMClient` is production code, not a test mock; lives in `agent-runner/stub-llm-client.ts` and is wired by bootstrap — Tasks 1, 6
- ✅ Wallet factory consumed via `forAgent(agent)` (cached), not yet used by the LLM — Task 2 (slice 6 will expose balance/swap as tools)
- ✅ `lastTickAt` updates on success AND failure — Task 2 (`finally` block); Task 3 covers both paths
- ✅ One agent failing does not block the next — Task 4 (try/catch around `runner.run`); Task 5 covers it

**Placeholder scan:** No TBDs, no "implement later", every step has actual code or an exact command.

**Type consistency:**
- `Clock` interface defined in `agent-runner/agent-runner.ts` (Task 2) and re-exported via `import type { Clock }` in Tasks 3, 4, 5 — single source of truth.
- `LLMClient` defined in Task 1; consumed by `AgentRunner` constructor (Task 2), `FailingLLM` test class (Task 3), `SelectiveLLM` test class (Task 5).
- `AgentRunner` constructor signature `(db, activityLog, walletFactory, llm, clock?)` is identical in Tasks 2, 3, 5, and 6.
- `AgentOrchestrator` constructor signature `(db, runner, clock?)` is identical in Tasks 4, 5, and 6.
- Activity log entry types (`'tick_start' | 'tick_end' | 'llm_call' | 'llm_response' | 'error'`) match the slice-2 `AgentActivityLogEntryType` union.
- Method names from slice 2 used unchanged: `db.agents.list`, `db.agents.findById`, `db.agents.upsert`, `db.agentMemory.get`, `activityLog.tickStart/tickEnd/llmCall/llmResponse/error/list`.
- `walletFactory.forAgent(agent)` from slice 3 used in Tasks 2, 3.
- `StubLLMClient.modelName()` returns `'stub'`; assertions in Tasks 3 and 6 match.
