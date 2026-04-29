# Worker / Server Split + Redis Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic `index.ts` (which can run looper + API server + tick queue + SSE in one process via `MODE=both|looper|server`) into two independently runnable processes — `worker` (scheduler + orchestrator + tick dispatcher) and `server` (HTTP API). Cross-process tick enqueueing and SSE event delivery are backed by Redis. Rename the `agent-looper/` module to `agent-worker/` and drop the `MODE` env var.

**Architecture:** Today the `InMemoryTickQueue` ships closures (`run: () => Promise<void>`) between producer (server route) and consumer (orchestrator) — only viable in one process. We refactor the queue to a serializable payload (`{ agentId, trigger, chatContent? }`) and introduce a `TickDispatcher` that owns the closure-construction step. Two `TickQueue` impls: `InMemoryTickQueue` (single-process, tests) and `RedisTickQueue` (Redis LIST + BRPOP). SSE switches from a per-process `EventEmitter` to an `ActivityBus` interface with two impls: `InMemoryActivityBus` (tests) and `RedisActivityBus` (pub/sub). `AgentActivityLog` writes to DB then publishes to the bus, regardless of which process it lives in. Server subscribes to bus events for SSE; worker subscribes to nothing (it's the publisher). Two thin entry scripts (`worker.ts`, `server.ts`) replace the unified `index.ts`.

**Tech Stack:** TypeScript, Node 20+, Express 5, Prisma 6, Redis 7 (`ioredis` 5.x), Vitest, Postgres 16.

---

## File Structure

**Rename (mechanical):**
- `src/agent-looper/` → `src/agent-worker/`
- `src/agent-looper/looper.ts` → `src/agent-worker/interval-scheduler.ts` (class `Looper` → `IntervalScheduler`)
- `src/constants/looper.ts` → `src/constants/worker.ts` (export `WORKER` instead of `LOOPER`)

**Modify:**
- `src/agent-runner/tick-queue.ts` — `TickQueue` interface becomes payload-based; `InMemoryTickQueue` updated to match
- `src/agent-worker/agent-orchestrator.ts` — enqueues payload instead of closure; no longer touches `runner` directly
- `src/database/agent-activity-log.ts` — uses `ActivityBus` instead of inline `EventEmitter`
- `src/api-server/routes/messages.ts` — enqueue payload instead of closure
- `src/api-server/server.ts` — drop `runner`, `walletProvisioner` becomes optional… (no, keep — needed by `/users/me/wallets`)
- `src/config/env.ts` — drop `MODE`; add `REDIS_URL`
- `src/index.ts` — DELETE (replaced by `worker.ts` + `server.ts`)
- `package.json` — replace `start*` scripts; drop `MODE=…` prefixes
- `docker-compose.yml` — add Redis service
- `.env.example` — drop `MODE`, add `REDIS_URL`
- `README.md` — process model section, env, scripts

**Create:**
- `src/agent-worker/tick-dispatcher.ts` — drains a `TickQueue`, builds the runner closure from the payload, calls `AgentRunner.run`
- `src/agent-runner/redis-tick-queue.ts` — Redis LIST impl (LPUSH from server, BRPOP in worker)
- `src/agent-runner/tick-queue-payload.ts` — wire-format type + zod schema
- `src/database/activity-bus.ts` — `ActivityBus` interface + `InMemoryActivityBus`
- `src/redis/redis-client.ts` — shared `ioredis` factory + URL parser
- `src/redis/redis-activity-bus.ts` — pub/sub-backed `ActivityBus`
- `src/worker.ts` — entry: env → DB → runner → orchestrator → dispatcher → scheduler
- `src/server.ts` — entry: env → DB → API → queue producer

**Test:**
- `src/agent-worker/agent-orchestrator.live.test.ts` — keep, port to payload-based queue
- `src/agent-worker/tick-dispatcher.live.test.ts` — NEW, drains in-memory queue
- `src/agent-runner/redis-tick-queue.live.test.ts` — NEW, requires `REDIS_URL` (skipped otherwise)
- `src/redis/redis-activity-bus.live.test.ts` — NEW, requires `REDIS_URL`

---

## Task 1: Rename `agent-looper/` → `agent-worker/` (mechanical)

**Files:**
- Move: `src/agent-looper/` → `src/agent-worker/`
- Move: `src/agent-looper/looper.ts` → `src/agent-worker/interval-scheduler.ts`
- Modify: `src/constants/looper.ts` → `src/constants/worker.ts`
- Modify: `src/constants/index.ts:1`
- Modify: `src/index.ts` (imports + log prefix)

- [ ] **Step 1: Move the directory**

```bash
git mv src/agent-looper src/agent-worker
git mv src/agent-worker/looper.ts src/agent-worker/interval-scheduler.ts
```

- [ ] **Step 2: Rename the class in `src/agent-worker/interval-scheduler.ts`**

Replace the entire file contents:

```typescript
export interface IntervalSchedulerOptions {
  tickIntervalMs: number;
  onTick: () => Promise<void>;
}

export class IntervalScheduler {
  private readonly tickIntervalMs: number;
  private readonly onTick: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: IntervalSchedulerOptions) {
    this.tickIntervalMs = opts.tickIntervalMs;
    this.onTick = opts.onTick;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.onTick().catch((err) => {
        console.error('[scheduler] tick error:', err);
      });
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
```

- [ ] **Step 3: Rename constants file**

```bash
git mv src/constants/looper.ts src/constants/worker.ts
```

Replace `src/constants/worker.ts` contents:

```typescript
export const WORKER = {
  tickIntervalMs: 10_000,
} as const;
```

- [ ] **Step 4: Update `src/constants/index.ts`**

Replace `export * from './looper';` with `export * from './worker';`. Keep the other lines (`agent-runner`, `uniswap`).

- [ ] **Step 5: Update `src/index.ts` imports + usages**

In `src/index.ts`:

- Replace `import { LOOPER } from './constants';` with `import { WORKER } from './constants';`
- Replace `import { Looper } from './agent-looper/looper';` with `import { IntervalScheduler } from './agent-worker/interval-scheduler';`
- Replace `import { AgentOrchestrator } from './agent-looper/agent-orchestrator';` with `import { AgentOrchestrator } from './agent-worker/agent-orchestrator';`
- Replace `let looper: Looper | null = null;` with `let scheduler: IntervalScheduler | null = null;`
- Replace `looper = new Looper({ tickIntervalMs: LOOPER.tickIntervalMs, onTick: ... });` with `scheduler = new IntervalScheduler({ tickIntervalMs: WORKER.tickIntervalMs, onTick: ... });`
- Replace `looper.start();` with `scheduler.start();`
- Replace `if (looper) looper.stop();` with `if (scheduler) scheduler.stop();`
- Replace `[bootstrap] looper started, ticking every ${LOOPER.tickIntervalMs}ms` with `[bootstrap] scheduler started, ticking every ${WORKER.tickIntervalMs}ms`
- Replace the `[looper]` log prefix in the `onTick` body with `[worker]`.

- [ ] **Step 6: Update test imports**

In `src/agent-worker/agent-orchestrator.live.test.ts`, no path imports of `agent-looper` should remain (the file now lives at `src/agent-worker/`). The test imports `./agent-orchestrator` — leave that alone. Verify `git grep agent-looper -- 'src/**'` returns no hits.

```bash
git grep -n "agent-looper" -- 'src/**' 'scripts/**'
```

Expected: no output.

- [ ] **Step 7: Update doc references (non-blocking)**

`docs/superpowers/plans/*.md` and `docs/superpowers/specs/*.md` may reference `agent-looper/` historically. Leave them alone (historical record).

In `CLAUDE.md`, replace `agent-looper/         tick scheduler, gate logic` with `agent-worker/         tick scheduler, orchestrator, dispatcher` in the directory tree. Replace the `### Looper gate logic` heading with `### Scheduler gate logic` (and any uses of "looper" → "worker scheduler" inside that section).

- [ ] **Step 8: Run typecheck + tests**

```bash
npm run typecheck
npm test
```

Expected: typecheck passes; tests pass (or live tests skip if env missing) — same baseline as before.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(worker): rename agent-looper module to agent-worker, Looper → IntervalScheduler, LOOPER → WORKER"
```

---

## Task 2: Add Redis to docker-compose + env

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `src/config/env.ts`

- [ ] **Step 1: Add Redis service to `docker-compose.yml`**

Replace the entire `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    container_name: agent-loop-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: agent_loop
    ports:
      - "5432:5432"
    volumes:
      - agent-loop-pgdata:/var/lib/postgresql/data
      - ./docker/postgres-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: agent-loop-redis
    ports:
      - "6379:6379"
    volumes:
      - agent-loop-redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 5s
      retries: 10

volumes:
  agent-loop-pgdata:
  agent-loop-redisdata:
```

- [ ] **Step 2: Update `.env.example`**

Two edits in `.env.example`:

(a) Append a Redis block after the Postgres block:

```
# Redis (queue + activity bus, used by both worker and server)
REDIS_URL=redis://localhost:6379
```

(b) Update the Privy comment line. Replace:

```
# Privy (required when MODE=server or MODE=both)
```

with:

```
# Privy (required by the server process)
```

(Per CLAUDE.md "`.env.example` stays in sync with `config/env.ts`" — every zod schema change must update `.env.example` in the same commit.)

- [ ] **Step 3: Add `REDIS_URL` to `src/config/env.ts`, drop `MODE`**

Replace `src/config/env.ts` contents:

```typescript
import { z } from 'zod';

const envSchema = z.object({
  WALLET_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x-prefixed 32-byte hex'),

  ALCHEMY_API_KEY: z.string().min(1),
  UNICHAIN_RPC_URL: z.string().url().optional(),

  ZEROG_NETWORK: z.enum(['mainnet', 'testnet']),
  ZEROG_PROVIDER_ADDRESS: z.string().min(1).optional(),

  COINGECKO_API_KEY: z.string().min(1),
  COINMARKETCAP_API_KEY: z.string().min(1),
  SERPER_API_KEY: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),

  DB_DIR: z.string().default('./db'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),

  REDIS_URL: z.string().url(),

  PRIVY_APP_ID: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid env: ${issues}`);
  }
  return parsed.data;
}
```

Note: `MODE` is removed; `REDIS_URL` is required (no default — fail fast if missing).

- [ ] **Step 4: Add `ioredis` dependency**

```bash
npm install ioredis@^5.4.1
```

- [ ] **Step 5: Bring Redis up**

```bash
docker compose up -d redis postgres
docker compose ps
```

Expected: both containers `healthy` within ~10s.

- [ ] **Step 6: Quick connectivity check**

```bash
docker compose exec redis redis-cli ping
```

Expected: `PONG`.

- [ ] **Step 7: Update `src/index.ts` to keep typechecking (transient)**

`MODE` is gone from env, but `src/index.ts` still references `env.MODE`. Until it's deleted in Task 7, patch `src/index.ts` so the project still typechecks: replace the four `env.MODE === '…'` references with hardcoded `true` (since the legacy script ran "both"), and replace the `MODE=${env.MODE}` log fragment with a literal:

In `src/index.ts`:
- `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}, MODE=${env.MODE}` → `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}` (drop MODE entirely)
- `if (env.MODE === 'server' || env.MODE === 'both') {` → `{` (always run the server)  
  *(close the orphan `}` accordingly — i.e. remove the surrounding `if` keeping the body)*
- `const runLooper = env.MODE === 'looper' || env.MODE === 'both';` → `const runLooper = true;`
- `const runServer = env.MODE === 'server' || env.MODE === 'both';` → `const runServer = true;`

This keeps `npm run start` working as the (deprecated, soon-to-be-deleted) "both" entry while we land Tasks 3–6.

- [ ] **Step 8: Run typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(infra): add redis service + REDIS_URL env, drop MODE env var"
```

---

## Task 3: Refactor `TickQueue` to payload-based interface

**Files:**
- Create: `src/agent-runner/tick-queue-payload.ts`
- Modify: `src/agent-runner/tick-queue.ts`
- Create: `src/agent-worker/tick-dispatcher.ts`
- Modify: `src/agent-worker/agent-orchestrator.ts`
- Modify: `src/api-server/routes/messages.ts`
- Modify: `src/agent-worker/agent-orchestrator.live.test.ts`
- Modify: `src/index.ts`
- Modify: `src/api-server/server.ts`

The closure-based `TickQueue` cannot be Redis-backed (closures don't serialize). This task makes the interface payload-only and adds a `TickDispatcher` that owns the closure-construction step. After this task, `InMemoryTickQueue` is still single-process — Redis-backed swap-in lands in Task 5.

- [ ] **Step 1: Define wire-format payload**

Create `src/agent-runner/tick-queue-payload.ts`:

```typescript
import { z } from 'zod';

export const TickPayloadSchema = z.discriminatedUnion('trigger', [
  z.object({
    trigger: z.literal('scheduled'),
    agentId: z.string().min(1),
    enqueuedAt: z.number().int().nonnegative(),
  }),
  z.object({
    trigger: z.literal('chat'),
    agentId: z.string().min(1),
    chatContent: z.string().min(1),
    enqueuedAt: z.number().int().nonnegative(),
  }),
]);

export type TickPayload = z.infer<typeof TickPayloadSchema>;
```

- [ ] **Step 2: Rewrite `src/agent-runner/tick-queue.ts`**

Replace the entire file:

```typescript
import type { TickPayload } from './tick-queue-payload';

export type TickTrigger = TickPayload['trigger'];

export interface QueueSnapshot {
  current: { agentId: string; trigger: TickTrigger; startedAt: number } | null;
  pending: { agentId: string; trigger: TickTrigger; enqueuedAt: number }[];
}

export interface TickQueue {
  enqueue(payload: Omit<TickPayload, 'enqueuedAt'>): Promise<{ position: number }>;
  hasScheduledFor(agentId: string): Promise<boolean>;
  snapshot(): Promise<QueueSnapshot>;
  /** Subscribe a single consumer. Returns an async iterator of payloads. The iterator must be closed via `stop()`. */
  consume(): TickQueueConsumer;
}

export interface TickQueueConsumer {
  next(): Promise<TickPayload | null>; // null = consumer was stopped
  stop(): Promise<void>;
}

export interface InMemoryTickQueueDeps {
  now?: () => number;
  notify?: (agentId: string, payload: Record<string, unknown>) => void;
}

export class InMemoryTickQueue implements TickQueue {
  private pending: TickPayload[] = [];
  private current: { agentId: string; trigger: TickTrigger; startedAt: number } | null = null;
  private waiters: Array<(p: TickPayload | null) => void> = [];
  private stopped = false;
  private now: () => number;
  private notify: (agentId: string, payload: Record<string, unknown>) => void;

  constructor(deps: InMemoryTickQueueDeps | (() => number) = {}) {
    if (typeof deps === 'function') {
      this.now = deps;
      this.notify = () => {};
    } else {
      this.now = deps.now ?? Date.now;
      this.notify = deps.notify ?? (() => {});
    }
  }

  async enqueue(payload: Omit<TickPayload, 'enqueuedAt'>): Promise<{ position: number }> {
    const full = { ...payload, enqueuedAt: this.now() } as TickPayload;
    this.pending.push(full);
    const position = this.pending.length + (this.current ? 1 : 0);
    this.notify(full.agentId, { type: 'task_queued', position, trigger: full.trigger });
    this.flushWaiter();
    return { position };
  }

  async hasScheduledFor(agentId: string): Promise<boolean> {
    if (this.current && this.current.agentId === agentId && this.current.trigger === 'scheduled') return true;
    return this.pending.some((p) => p.agentId === agentId && p.trigger === 'scheduled');
  }

  async snapshot(): Promise<QueueSnapshot> {
    return {
      current: this.current ? { ...this.current } : null,
      pending: this.pending.map((p) => ({ agentId: p.agentId, trigger: p.trigger, enqueuedAt: p.enqueuedAt })),
    };
  }

  consume(): TickQueueConsumer {
    return {
      next: () => this.pull(),
      stop: async () => {
        this.stopped = true;
        for (const w of this.waiters) w(null);
        this.waiters = [];
      },
    };
  }

  /** Test helper — set the running task and clear when done. Used by TickDispatcher. */
  markStarted(payload: TickPayload): void {
    this.current = { agentId: payload.agentId, trigger: payload.trigger, startedAt: this.now() };
    this.notify(payload.agentId, { type: 'task_started', trigger: payload.trigger });
  }

  markFinished(payload: TickPayload): void {
    this.notify(payload.agentId, { type: 'task_finished', trigger: payload.trigger });
    this.current = null;
  }

  private pull(): Promise<TickPayload | null> {
    if (this.stopped) return Promise.resolve(null);
    const next = this.pending.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private flushWaiter(): void {
    const w = this.waiters.shift();
    if (!w) return;
    const next = this.pending.shift();
    w(next ?? null);
  }
}
```

Note: `enqueue` no longer takes a `run` closure. `hasScheduledFor` and `snapshot` are now async (forward-compatible with Redis). `consume()` returns a stoppable async iterator. `markStarted/markFinished` are called by the dispatcher (not a "drain" callback baked into the queue).

- [ ] **Step 3: Create `TickDispatcher`**

Create `src/agent-worker/tick-dispatcher.ts`:

```typescript
import type { Database } from '../database/database';
import type { AgentRunner, Clock } from '../agent-runner/agent-runner';
import type { AgentActivityLog } from '../database/agent-activity-log';
import type { TickQueue, TickQueueConsumer } from '../agent-runner/tick-queue';
import { ChatTickStrategy } from '../agent-runner/tick-strategies/chat-tick-strategy';
import type { TickPayload } from '../agent-runner/tick-queue-payload';

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export interface TickDispatcherDeps {
  db: Database;
  runner: AgentRunner;
  activityLog: AgentActivityLog;
  queue: TickQueue;
  clock?: Clock;
}

export class TickDispatcher {
  private consumer: TickQueueConsumer | null = null;
  private running = false;
  private idle = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(private readonly deps: TickDispatcherDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.consumer = this.deps.queue.consume();
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.consumer) await this.consumer.stop();
    await this.idle;
  }

  /** Test helper — resolves once the in-flight task (if any) finishes. */
  drain(): Promise<void> {
    return this.idle;
  }

  private async loop(): Promise<void> {
    while (this.running && this.consumer) {
      const payload = await this.consumer.next();
      if (!payload) break;
      this.idle = new Promise((resolve) => {
        this.resolveIdle = resolve;
      });
      try {
        await this.dispatch(payload);
      } catch (err) {
        console.error(`[dispatcher] payload for agent=${payload.agentId} trigger=${payload.trigger} threw:`, err);
      } finally {
        const r = this.resolveIdle;
        this.resolveIdle = null;
        if (r) r();
      }
    }
  }

  private async dispatch(payload: TickPayload): Promise<void> {
    const agent = await this.deps.db.agents.findById(payload.agentId);
    if (!agent) {
      console.warn(`[dispatcher] payload references unknown agent=${payload.agentId}; dropping`);
      return;
    }
    const log = this.deps.activityLog;
    const onToken = (text: string) => log.emitEphemeral(payload.agentId, { type: 'token', text });
    if (payload.trigger === 'chat') {
      const strategy = new ChatTickStrategy(log, payload.chatContent);
      await this.deps.runner.run(agent, strategy, { onToken });
    } else {
      await this.deps.runner.run(agent, undefined, { onToken });
    }
  }
}
```

- [ ] **Step 4: Update `AgentOrchestrator` to enqueue payloads**

Replace `src/agent-worker/agent-orchestrator.ts`:

```typescript
import type { AgentActivityLog } from '../database/agent-activity-log';
import type { Database } from '../database/database';
import type { Clock } from '../agent-runner/agent-runner';
import type { TickQueue } from '../agent-runner/tick-queue';

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly queue: TickQueue,
    private readonly clock: Clock = SYSTEM_CLOCK,
    private readonly _activityLog?: AgentActivityLog,
  ) {}

  async tick(): Promise<void> {
    const now = this.clock.now();
    const all = await this.db.agents.list();
    const due = all.filter(
      (a) => a.running === true && (a.intervalMs ?? 0) > 0 && now - (a.lastTickAt ?? 0) >= (a.intervalMs ?? 0),
    );

    for (const agent of due) {
      if (await this.queue.hasScheduledFor(agent.id)) continue;
      await this.db.agents.upsert({ ...agent, lastTickAt: now });
      await this.queue.enqueue({ trigger: 'scheduled', agentId: agent.id });
    }
  }
}
```

The orchestrator no longer needs `runner` — it just enqueues. `activityLog` is unused now too; keep the parameter so the test file (which passes 4 args) still constructs cleanly, marked `_activityLog` to silence unused warnings.

Actually — no. Drop the unused `_activityLog` parameter and update the call site in the test to match (next step).

Final orchestrator:

```typescript
import type { Database } from '../database/database';
import type { Clock } from '../agent-runner/agent-runner';
import type { TickQueue } from '../agent-runner/tick-queue';

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly queue: TickQueue,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async tick(): Promise<void> {
    const now = this.clock.now();
    const all = await this.db.agents.list();
    const due = all.filter(
      (a) => a.running === true && (a.intervalMs ?? 0) > 0 && now - (a.lastTickAt ?? 0) >= (a.intervalMs ?? 0),
    );

    for (const agent of due) {
      if (await this.queue.hasScheduledFor(agent.id)) continue;
      await this.db.agents.upsert({ ...agent, lastTickAt: now });
      await this.queue.enqueue({ trigger: 'scheduled', agentId: agent.id });
    }
  }
}
```

- [ ] **Step 5: Update `src/api-server/routes/messages.ts`**

Replace the body of the `r.post('/', ...)` handler so it enqueues a payload (and stops importing `ChatTickStrategy` / `AgentRunner`):

```typescript
import { Router } from 'express';
import type { AgentActivityLog } from '../../database/agent-activity-log';
import {
  projectChatMessages,
  type ChatMessageView,
} from '../../agent-runner/tick-strategies/chat-history-projection';
import type { TickQueue } from '../../agent-runner/tick-queue';
import type { Database } from '../../database/database';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import { PaginationQuerySchema, PostMessageBodySchema } from '../openapi/schemas';

interface Deps {
  db: Database;
  activityLog: AgentActivityLog;
  queue: TickQueue;
}

export function buildMessagesRouter(deps: Deps): Router {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const agent = await deps.db.agents.findById(agentId);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();

      const q = PaginationQuerySchema.parse(req.query);
      const entries = await deps.activityLog.list(agentId);
      let views: ChatMessageView[] = projectChatMessages(entries);

      if (q.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(q.cursor);
        } catch {
          throw new BadRequestError('invalid_cursor');
        }
        if (q.order === 'desc') {
          views = views.filter(
            (v) =>
              v.createdAt < cursor.createdAt ||
              (v.createdAt === cursor.createdAt && viewId(v) < cursor.id),
          );
        } else {
          views = views.filter(
            (v) =>
              v.createdAt > cursor.createdAt ||
              (v.createdAt === cursor.createdAt && viewId(v) > cursor.id),
          );
        }
      }

      if (q.order === 'desc') views = [...views].reverse();

      const items = views.slice(0, q.limit);
      const last = items[items.length - 1];
      const nextCursor =
        items.length === q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: viewId(last) })
          : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const body = PostMessageBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(agentId);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();

      const result = await deps.queue.enqueue({
        trigger: 'chat',
        agentId,
        chatContent: body.content,
      });
      res.status(202).json({ position: result.position });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

function viewId(v: ChatMessageView): string {
  return String(v.seq);
}
```

- [ ] **Step 6: Drop `runner` from `ApiServerDeps`**

In `src/api-server/server.ts`:

- Remove `runner` from `ApiServerDeps`
- Remove the `import type { AgentRunner } …` line
- Update the `buildMessagesRouter({ db, activityLog, runner, queue })` call — drop `runner`

Final `ApiServerDeps`:

```typescript
export interface ApiServerDeps {
  db: Database;
  activityLog: AgentActivityLog;
  queue: TickQueue;
  privyAuth: PrivyAuth;
  walletProvisioner: WalletProvisioner;
  port: number;
  corsOrigins?: string;
}
```

And the messages router wiring becomes:

```typescript
this.app.use('/agents/:id/messages', buildMessagesRouter({ db: deps.db, activityLog: deps.activityLog, queue: deps.queue }));
```

- [ ] **Step 7: Port `src/agent-worker/agent-orchestrator.live.test.ts` to the new shape**

(Post-rebase the file uses plain `describe(...)` and `getTestPrisma()` throws on missing `TEST_DATABASE_URL` — no more `describeIfPostgres`.)

Edit the test file. Key diffs:

1. `AgentOrchestrator` constructor is now `(db, queue, clock)`, no `runner`, no `activityLog`.
2. To execute the queued payloads, instantiate a `TickDispatcher`.
3. Replace `await queue.drain()` with `await dispatcher.drain()` (after the dispatcher has consumed the just-enqueued items).

Concretely, in the `beforeEach`:

```typescript
import { TickDispatcher } from './tick-dispatcher';
// ...

let dispatcher: TickDispatcher;
// ...

beforeEach(async () => {
  // ... existing setup ...
  queue = new InMemoryTickQueue(() => clock.now());
  orchestrator = new AgentOrchestrator(db, queue, clock);
  dispatcher = new TickDispatcher({ db, runner, activityLog, queue, clock });
  dispatcher.start();
});

afterEach(async () => {
  await dispatcher.stop();
});
```

Replace every `await queue.drain();` with `await dispatcher.drain();`. There is one place that constructs a second orchestrator/queue inline (the "one agent failing does not block the next agent" test):

```typescript
const failingRunner = new AgentRunner(...);
const failingQueue = new InMemoryTickQueue(() => clock.now());
const failingOrch = new AgentOrchestrator(db, failingQueue, clock);
const failingDispatcher = new TickDispatcher({ db, runner: failingRunner, activityLog, queue: failingQueue, clock });
failingDispatcher.start();
try {
  await failingOrch.tick();
  await failingDispatcher.drain();
  // ... assertions ...
} finally {
  await failingDispatcher.stop();
}
```

- [ ] **Step 8: Add `afterEach` import**

In the same test file, update the imports: `import { it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';`.

- [ ] **Step 9: Update `src/index.ts` to use the dispatcher**

Currently `src/index.ts` constructs orchestrator with `(db, runner, queue, undefined, activityLog)`. Replace with:

```typescript
import { TickDispatcher } from './agent-worker/tick-dispatcher';
// ...

let scheduler: IntervalScheduler | null = null;
let dispatcher: TickDispatcher | null = null;
if (runLooper) {
  const orchestrator = new AgentOrchestrator(db, queue);
  dispatcher = new TickDispatcher({ db, runner, activityLog, queue });
  dispatcher.start();
  scheduler = new IntervalScheduler({
    tickIntervalMs: WORKER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(`[worker] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`);
      await orchestrator.tick();
    },
  });
  scheduler.start();
  console.log(`[bootstrap] scheduler started, ticking every ${WORKER.tickIntervalMs}ms`);
}
```

And in shutdown:

```typescript
const shutdown = async (signal: string) => {
  console.log(`[bootstrap] received ${signal}, stopping`);
  if (scheduler) scheduler.stop();
  if (dispatcher) await dispatcher.stop().catch(() => {});
  if (api) await api.stop().catch(() => {});
  await db.disconnect().catch(() => {});
  process.exit(0);
};
```

The `runner` instance is now wired into the dispatcher (was wired into orchestrator before).

- [ ] **Step 10: Run typecheck + tests**

```bash
npm run typecheck
npm test
```

Expected: typecheck passes; orchestrator live tests pass when `TEST_DATABASE_URL` is set, skip otherwise. Existing live tests continue to pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(queue): make TickQueue payload-based; introduce TickDispatcher"
```

---

## Task 4: Add `ActivityBus` abstraction

**Files:**
- Create: `src/database/activity-bus.ts`
- Modify: `src/database/agent-activity-log.ts`
- Modify: `src/index.ts`
- Modify: any test that constructs `AgentActivityLog` — none today pass a bus, so they all use the in-memory default.

- [ ] **Step 1: Create `ActivityBus` interface + in-memory impl**

Create `src/database/activity-bus.ts`:

```typescript
import { EventEmitter } from 'node:events';
import type { AgentActivityLogEntry } from './types';

export type AgentActivityEvent =
  | { kind: 'append'; entry: AgentActivityLogEntry }
  | { kind: 'ephemeral'; agentId: string; payload: Record<string, unknown> };

export interface ActivityBus {
  publish(event: AgentActivityEvent): Promise<void>;
  subscribe(agentId: string, listener: (event: AgentActivityEvent) => void): () => void;
  close(): Promise<void>;
}

export class InMemoryActivityBus implements ActivityBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  async publish(event: AgentActivityEvent): Promise<void> {
    const agentId = event.kind === 'append' ? event.entry.agentId : event.agentId;
    this.emitter.emit(`agent:${agentId}`, event);
  }

  subscribe(agentId: string, listener: (event: AgentActivityEvent) => void): () => void {
    const eventName = `agent:${agentId}`;
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}
```

- [ ] **Step 2: Refactor `AgentActivityLog` to use `ActivityBus`**

Replace `src/database/agent-activity-log.ts`:

```typescript
import type { ActivityLogRepository } from './repositories/activity-log-repository';
import type { AgentActivityLogEntry, AgentActivityLogEntryType } from './types';
import { InMemoryActivityBus, type ActivityBus, type AgentActivityEvent } from './activity-bus';

export type { AgentActivityEvent } from './activity-bus';

export class AgentActivityLog {
  private readonly bus: ActivityBus;

  constructor(private readonly repo: ActivityLogRepository, bus?: ActivityBus) {
    this.bus = bus ?? new InMemoryActivityBus();
  }

  on(agentId: string, listener: (event: AgentActivityEvent) => void): () => void {
    return this.bus.subscribe(agentId, listener);
  }

  emitEphemeral(agentId: string, payload: Record<string, unknown>): void {
    void this.bus.publish({ kind: 'ephemeral', agentId, payload });
  }

  tickStart(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_start', payload);
  }
  tickEnd(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_end', payload);
  }
  userMessage(agentId: string, tickId: string, payload: { content: string }): Promise<void> {
    return this.write(agentId, tickId, 'user_message', payload);
  }
  toolCall(agentId: string, tickId: string, payload: { id: string; tool: string; input: unknown }): Promise<void> {
    return this.write(agentId, tickId, 'tool_call', payload);
  }
  toolResult(
    agentId: string,
    tickId: string,
    payload: { id: string; tool: string; output: unknown; durationMs: number },
  ): Promise<void> {
    return this.write(agentId, tickId, 'tool_result', payload);
  }
  llmCall(agentId: string, tickId: string, payload: { model: string; promptChars: number }): Promise<void> {
    return this.write(agentId, tickId, 'llm_call', payload);
  }
  llmResponse(
    agentId: string,
    tickId: string,
    payload: {
      model: string;
      responseChars: number;
      tokenCount?: number;
      content: string;
      toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
    },
  ): Promise<void> {
    return this.write(agentId, tickId, 'llm_response', payload);
  }
  memoryUpdate(
    agentId: string,
    tickId: string,
    payload: {
      tool: 'updateMemory' | 'saveMemoryEntry';
      keysChanged: string[];
      state?: Record<string, unknown>;
      appendNote?: string;
      entry?: { type: string; content: string; parentEntryIds?: string[] };
    },
  ): Promise<void> {
    return this.write(agentId, tickId, 'memory_update', payload);
  }
  error(
    agentId: string,
    tickId: string,
    payload: { message: string; stack?: string; tool?: string },
  ): Promise<void> {
    return this.write(agentId, tickId, 'error', payload);
  }

  list(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]> {
    return this.repo.listByAgent(agentId, opts);
  }

  private async write(
    agentId: string,
    tickId: string,
    type: AgentActivityLogEntryType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const entry = await this.repo.append({
      agentId,
      tickId,
      timestamp: Date.now(),
      type,
      payload,
    });
    await this.bus.publish({ kind: 'append', entry });
  }
}
```

- [ ] **Step 3: Run typecheck + tests**

```bash
npm run typecheck
npm test
```

Expected: pass. The `AgentActivityEvent` type is re-exported from `agent-activity-log` so existing imports (e.g. `src/api-server/routes/stream.ts`) don't break.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(activity-log): extract ActivityBus interface with InMemoryActivityBus impl"
```

---

## Task 5: Implement Redis-backed `TickQueue` + `ActivityBus`

**Files:**
- Create: `src/redis/redis-client.ts`
- Create: `src/agent-runner/redis-tick-queue.ts`
- Create: `src/redis/redis-activity-bus.ts`
- Create: `src/agent-runner/redis-tick-queue.live.test.ts`
- Create: `src/redis/redis-activity-bus.live.test.ts`

**Test policy reminder (from CLAUDE.md):** live tests **fail loudly** when their dependencies are missing — no `skipIf` guards. Operators must have Redis running before `npm test`. Tests hit a real Redis (free), use a test-scoped key prefix, and clean up after themselves.

- [ ] **Step 1: Shared Redis client factory**

Create `src/redis/redis-client.ts`:

```typescript
import IORedis, { type Redis, type RedisOptions } from 'ioredis';

export function buildRedisClient(url: string, opts: RedisOptions = {}): Redis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts,
  });
}
```

`maxRetriesPerRequest: null` is required for `BRPOP`-style blocking commands.

- [ ] **Step 2: Write the failing test for `RedisTickQueue` round-trip**

Create `src/agent-runner/redis-tick-queue.live.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildRedisClient } from '../redis/redis-client';
import { RedisTickQueue } from './redis-tick-queue';

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required to run live Redis tests');
  return url;
}

describe('RedisTickQueue (live)', () => {
  const REDIS_URL = requireRedisUrl();
  const keyPrefix = `test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const producer = buildRedisClient(REDIS_URL);
  const subscriber = buildRedisClient(REDIS_URL);

  let queue: RedisTickQueue;

  beforeEach(() => {
    queue = new RedisTickQueue({ producer, subscriber, keyPrefix });
  });

  afterEach(async () => {
    await producer.del(`${keyPrefix}:queue`);
  });

  it('round-trips a chat payload from producer to consumer', async () => {
    const consumer = queue.consume();
    await queue.enqueue({ trigger: 'chat', agentId: 'a1', chatContent: 'hi' });
    const got = await consumer.next();
    console.log('[redis-tq] popped:', got);
    expect(got).toMatchObject({ trigger: 'chat', agentId: 'a1', chatContent: 'hi' });
    await consumer.stop();
  });

  it('hasScheduledFor finds a scheduled payload before it is consumed', async () => {
    await queue.enqueue({ trigger: 'scheduled', agentId: 'a2' });
    expect(await queue.hasScheduledFor('a2')).toBe(true);
    expect(await queue.hasScheduledFor('a3')).toBe(false);

    const consumer = queue.consume();
    await consumer.next();
    expect(await queue.hasScheduledFor('a2')).toBe(false);
    await consumer.stop();
  });

  it('preserves FIFO order across two enqueues', async () => {
    await queue.enqueue({ trigger: 'chat', agentId: 'a1', chatContent: 'first' });
    await queue.enqueue({ trigger: 'chat', agentId: 'a1', chatContent: 'second' });
    const consumer = queue.consume();
    const a = await consumer.next();
    const b = await consumer.next();
    console.log('[redis-tq] order:', a?.trigger, b?.trigger);
    expect(a).toMatchObject({ chatContent: 'first' });
    expect(b).toMatchObject({ chatContent: 'second' });
    await consumer.stop();
  });

  it('stop() unblocks a waiting consumer with null', async () => {
    const consumer = queue.consume();
    const pending = consumer.next();
    setTimeout(() => void consumer.stop(), 50);
    const got = await pending;
    expect(got).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
REDIS_URL=redis://localhost:6379 npx vitest run src/agent-runner/redis-tick-queue.live.test.ts
```

Expected: FAIL with "Cannot find module './redis-tick-queue'".

- [ ] **Step 4: Implement `RedisTickQueue`**

Create `src/agent-runner/redis-tick-queue.ts`:

```typescript
import type { Redis } from 'ioredis';
import {
  TickPayloadSchema,
  type TickPayload,
} from './tick-queue-payload';
import type {
  QueueSnapshot,
  TickQueue,
  TickQueueConsumer,
} from './tick-queue';

export interface RedisTickQueueDeps {
  /** Used for LPUSH (server) and synchronous inspection (LRANGE / LLEN). */
  producer: Redis;
  /** Dedicated connection used for BRPOP. ioredis blocks the entire connection while BRPOP is in flight, so this MUST NOT be shared with `producer`. */
  subscriber: Redis;
  keyPrefix?: string;
  now?: () => number;
}

const DEFAULT_KEY_PREFIX = 'agent-loop';

export class RedisTickQueue implements TickQueue {
  private readonly listKey: string;
  private readonly producer: Redis;
  private readonly subscriber: Redis;
  private readonly now: () => number;
  private stopped = false;

  constructor(deps: RedisTickQueueDeps) {
    const prefix = deps.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.listKey = `${prefix}:queue`;
    this.producer = deps.producer;
    this.subscriber = deps.subscriber;
    this.now = deps.now ?? Date.now;
  }

  async enqueue(payload: Omit<TickPayload, 'enqueuedAt'>): Promise<{ position: number }> {
    const full = { ...payload, enqueuedAt: this.now() } as TickPayload;
    await this.producer.lpush(this.listKey, JSON.stringify(full));
    const len = await this.producer.llen(this.listKey);
    return { position: len };
  }

  async hasScheduledFor(agentId: string): Promise<boolean> {
    const items = await this.producer.lrange(this.listKey, 0, -1);
    for (const raw of items) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.agentId === agentId && parsed.trigger === 'scheduled') return true;
      } catch {
        // ignore malformed entries
      }
    }
    return false;
  }

  async snapshot(): Promise<QueueSnapshot> {
    const items = await this.producer.lrange(this.listKey, 0, -1);
    const pending = items
      .map((raw) => {
        try {
          return JSON.parse(raw) as TickPayload;
        } catch {
          return null;
        }
      })
      .filter((p): p is TickPayload => p !== null)
      .reverse() // LPUSH means newest is at index 0; reverse to enqueue-order
      .map((p) => ({ agentId: p.agentId, trigger: p.trigger, enqueuedAt: p.enqueuedAt }));
    return { current: null, pending };
  }

  consume(): TickQueueConsumer {
    return {
      next: () => this.pull(),
      stop: async () => {
        this.stopped = true;
        // Force any in-flight BRPOP to return by quitting the dedicated subscriber connection.
        try {
          await this.subscriber.quit();
        } catch {
          // already closed
        }
      },
    };
  }

  private async pull(): Promise<TickPayload | null> {
    if (this.stopped) return null;
    try {
      const result = await this.subscriber.brpop(this.listKey, 0);
      if (!result) return null;
      const [, raw] = result;
      const parsed = TickPayloadSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.error('[redis-tq] dropped malformed payload:', raw, parsed.error.format());
        return this.pull();
      }
      return parsed.data;
    } catch (err) {
      if (this.stopped) return null;
      throw err;
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
REDIS_URL=redis://localhost:6379 npx vitest run src/agent-runner/redis-tick-queue.live.test.ts
```

Expected: 4 passing.

- [ ] **Step 6: Write the failing test for `RedisActivityBus`**

Create `src/redis/redis-activity-bus.live.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildRedisClient } from './redis-client';
import { RedisActivityBus } from './redis-activity-bus';
import type { AgentActivityEvent } from '../database/activity-bus';

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required to run live Redis tests');
  return url;
}

describe('RedisActivityBus (live)', () => {
  const REDIS_URL = requireRedisUrl();
  const channelPrefix = `test:bus:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let publisher: RedisActivityBus;
  let subscriber: RedisActivityBus;

  beforeEach(() => {
    publisher = new RedisActivityBus({ publisher: buildRedisClient(REDIS_URL), subscriber: buildRedisClient(REDIS_URL), channelPrefix });
    subscriber = new RedisActivityBus({ publisher: buildRedisClient(REDIS_URL), subscriber: buildRedisClient(REDIS_URL), channelPrefix });
  });

  afterEach(async () => {
    await publisher.close();
    await subscriber.close();
  });

  it('delivers an ephemeral event from publisher to subscriber', async () => {
    const received: AgentActivityEvent[] = [];
    const unsubscribe = subscriber.subscribe('a1', (e) => received.push(e));

    // give the subscribe round-trip time to register on the redis connection
    await new Promise((r) => setTimeout(r, 100));

    await publisher.publish({ kind: 'ephemeral', agentId: 'a1', payload: { type: 'token', text: 'hello' } });

    await new Promise((r) => setTimeout(r, 100));
    console.log('[redis-bus] received:', received);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'ephemeral', payload: { type: 'token', text: 'hello' } });

    unsubscribe();
  });

  it('does not deliver to subscribers of a different agent', async () => {
    const received: AgentActivityEvent[] = [];
    subscriber.subscribe('other-agent', (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 100));

    await publisher.publish({ kind: 'ephemeral', agentId: 'a1', payload: { type: 'token' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

```bash
REDIS_URL=redis://localhost:6379 npx vitest run src/redis/redis-activity-bus.live.test.ts
```

Expected: FAIL with "Cannot find module './redis-activity-bus'".

- [ ] **Step 8: Implement `RedisActivityBus`**

Create `src/redis/redis-activity-bus.ts`:

```typescript
import type { Redis } from 'ioredis';
import type { ActivityBus, AgentActivityEvent } from '../database/activity-bus';

export interface RedisActivityBusDeps {
  /** Connection used for PUBLISH. */
  publisher: Redis;
  /** Connection used for SUBSCRIBE. ioredis subscribers cannot issue regular commands; MUST NOT be shared with `publisher`. */
  subscriber: Redis;
  channelPrefix?: string;
}

const DEFAULT_CHANNEL_PREFIX = 'agent-loop:activity';

export class RedisActivityBus implements ActivityBus {
  private readonly channelPrefix: string;
  private readonly listenersByAgent = new Map<string, Set<(e: AgentActivityEvent) => void>>();
  private readonly subscribedChannels = new Set<string>();
  private wired = false;

  constructor(private readonly deps: RedisActivityBusDeps) {
    this.channelPrefix = deps.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
  }

  async publish(event: AgentActivityEvent): Promise<void> {
    const agentId = event.kind === 'append' ? event.entry.agentId : event.agentId;
    await this.deps.publisher.publish(this.channelFor(agentId), JSON.stringify(event));
  }

  subscribe(agentId: string, listener: (event: AgentActivityEvent) => void): () => void {
    this.ensureWired();
    let bucket = this.listenersByAgent.get(agentId);
    if (!bucket) {
      bucket = new Set();
      this.listenersByAgent.set(agentId, bucket);
    }
    bucket.add(listener);

    const channel = this.channelFor(agentId);
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      void this.deps.subscriber.subscribe(channel);
    }

    return () => {
      bucket?.delete(listener);
      if (bucket && bucket.size === 0) {
        this.listenersByAgent.delete(agentId);
        this.subscribedChannels.delete(channel);
        void this.deps.subscriber.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.listenersByAgent.clear();
    this.subscribedChannels.clear();
    try {
      await this.deps.subscriber.quit();
    } catch {
      // already closed
    }
    try {
      await this.deps.publisher.quit();
    } catch {
      // already closed
    }
  }

  private ensureWired(): void {
    if (this.wired) return;
    this.wired = true;
    this.deps.subscriber.on('message', (channel: string, raw: string) => {
      const agentId = this.agentIdFromChannel(channel);
      if (!agentId) return;
      let event: AgentActivityEvent;
      try {
        event = JSON.parse(raw) as AgentActivityEvent;
      } catch {
        return;
      }
      const bucket = this.listenersByAgent.get(agentId);
      if (!bucket) return;
      for (const listener of bucket) {
        try {
          listener(event);
        } catch (err) {
          console.error('[redis-bus] listener threw:', err);
        }
      }
    });
  }

  private channelFor(agentId: string): string {
    return `${this.channelPrefix}:${agentId}`;
  }

  private agentIdFromChannel(channel: string): string | null {
    const prefix = `${this.channelPrefix}:`;
    if (!channel.startsWith(prefix)) return null;
    return channel.slice(prefix.length);
  }
}
```

- [ ] **Step 9: Run the bus test to verify it passes**

```bash
REDIS_URL=redis://localhost:6379 npx vitest run src/redis/redis-activity-bus.live.test.ts
```

Expected: 2 passing.

- [ ] **Step 10: Run the full test suite (sanity)**

```bash
npm run typecheck
REDIS_URL=redis://localhost:6379 npm test
```

Expected: all green; existing tests untouched, new live tests pass against the docker Redis.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(redis): add RedisTickQueue + RedisActivityBus with live tests"
```

---

## Task 6: Split `index.ts` into `worker.ts` + `server.ts`

**Files:**
- Create: `src/worker.ts`
- Create: `src/server.ts`
- Delete: `src/index.ts`

Each entry script wires only what its process needs. Both connect to Postgres + Redis; only the worker needs the LLM, wallet factory, runner, dispatcher, scheduler. Only the server needs Privy.

- [ ] **Step 1: Create `src/worker.ts`**

```typescript
import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { WORKER } from './constants';
import { IntervalScheduler } from './agent-worker/interval-scheduler';
import { AgentOrchestrator } from './agent-worker/agent-orchestrator';
import { TickDispatcher } from './agent-worker/tick-dispatcher';
import { PrismaClient } from '@prisma/client';
import { PrismaDatabase } from './database/prisma-database/prisma-database';
import { AgentActivityLog } from './database/agent-activity-log';
import { RedisActivityBus } from './redis/redis-activity-bus';
import { RedisTickQueue } from './agent-runner/redis-tick-queue';
import { buildRedisClient } from './redis/redis-client';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { StubLLMClient } from './agent-runner/stub-llm-client';
import type { LLMClient } from './agent-runner/llm-client';
import { ZeroGBootstrapStore } from './ai/zerog-broker/zerog-bootstrap-store';
import { buildZeroGBroker } from './ai/zerog-broker/zerog-broker-factory';
import { silenceZeroGSdkNoise } from './ai/zerog-broker/silence-sdk-noise';
import { ZeroGLLMClient } from './ai/chat-model/zerog-llm-client';
import { ToolRegistry } from './ai-tools/tool-registry';
import { CoingeckoService } from './providers/coingecko/coingecko-service';
import { CoinMarketCapService } from './providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from './providers/serper/serper-service';
import { FirecrawlService } from './providers/firecrawl/firecrawl-service';
import { UniswapService } from './uniswap/uniswap-service';

async function buildLLM(env: Env): Promise<LLMClient> {
  const store = new ZeroGBootstrapStore(env.DB_DIR);
  const state = await store.load();
  if (!state) {
    console.log('[bootstrap] no zerog-bootstrap.json; using StubLLMClient. Run `npm run zerog-bootstrap` to fund a 0G provider.');
    return new StubLLMClient();
  }
  if (state.network !== env.ZEROG_NETWORK) {
    console.warn(
      `[bootstrap] WARNING: zerog-bootstrap.json was funded on '${state.network}' but env says '${env.ZEROG_NETWORK}'; using the file's network.`,
    );
  }
  const { broker } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: state.network,
  });
  silenceZeroGSdkNoise();
  console.log(`[bootstrap] 0G LLM ready — network=${state.network} provider=${state.providerAddress} model=${state.model}`);
  return new ZeroGLLMClient({
    broker,
    providerAddress: state.providerAddress,
    serviceUrl: state.serviceUrl,
    model: state.model,
  });
}

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const db = new PrismaDatabase(prisma);

  const busPublisher = buildRedisClient(env.REDIS_URL);
  const busSubscriber = buildRedisClient(env.REDIS_URL);
  const activityBus = new RedisActivityBus({ publisher: busPublisher, subscriber: busSubscriber });
  const activityLog = new AgentActivityLog(db.activityLog, activityBus);

  const queueProducer = buildRedisClient(env.REDIS_URL);
  const queueSubscriber = buildRedisClient(env.REDIS_URL);
  const queue = new RedisTickQueue({ producer: queueProducer, subscriber: queueSubscriber });

  const walletFactory = new WalletFactory(env, db.transactions);
  const uniswap = new UniswapService(env, db);
  const llm = await buildLLM(env);
  const toolRegistry = new ToolRegistry({
    coingecko: new CoingeckoService({ apiKey: env.COINGECKO_API_KEY }),
    coinmarketcap: new CoinMarketCapService({ apiKey: env.COINMARKETCAP_API_KEY }),
    serper: new SerperService({ apiKey: env.SERPER_API_KEY }),
    firecrawl: new FirecrawlService({ apiKey: env.FIRECRAWL_API_KEY }),
    db,
    uniswap,
  });
  const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

  console.log(`[bootstrap] worker — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`);
  console.log(`[bootstrap] postgres at ${env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bootstrap] redis at ${env.REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bootstrap] tools=${toolRegistry.build().length} llm=${llm.modelName()}`);

  const orchestrator = new AgentOrchestrator(db, queue);
  const dispatcher = new TickDispatcher({ db, runner, activityLog, queue });
  dispatcher.start();

  const scheduler = new IntervalScheduler({
    tickIntervalMs: WORKER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(`[worker] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`);
      await orchestrator.tick();
    },
  });
  scheduler.start();
  console.log(`[bootstrap] scheduler started, ticking every ${WORKER.tickIntervalMs}ms`);

  const shutdown = async (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping`);
    scheduler.stop();
    await dispatcher.stop().catch(() => {});
    await activityBus.close().catch(() => {});
    await queueProducer.quit().catch(() => {});
    // queueSubscriber + busSubscriber were quit by their owners (RedisTickQueue.consume.stop, RedisActivityBus.close)
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Create `src/server.ts`**

```typescript
import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { ApiServer } from './api-server/server';
import { PrismaClient } from '@prisma/client';
import { PrismaDatabase } from './database/prisma-database/prisma-database';
import { AgentActivityLog } from './database/agent-activity-log';
import { RedisActivityBus } from './redis/redis-activity-bus';
import { RedisTickQueue } from './agent-runner/redis-tick-queue';
import { buildRedisClient } from './redis/redis-client';
import { PrivyAuth } from './api-server/auth/privy-auth';
import { WalletProvisioner } from './wallet/privy/wallet-provisioner';

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }

  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    console.error('[bootstrap] PRIVY_APP_ID + PRIVY_APP_SECRET are required for the server');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const db = new PrismaDatabase(prisma);

  const busPublisher = buildRedisClient(env.REDIS_URL);
  const busSubscriber = buildRedisClient(env.REDIS_URL);
  const activityBus = new RedisActivityBus({ publisher: busPublisher, subscriber: busSubscriber });
  const activityLog = new AgentActivityLog(db.activityLog, activityBus);

  const queueProducer = buildRedisClient(env.REDIS_URL);
  // server only enqueues; it never consumes. Pass a no-op subscriber.
  const queueSubscriber = buildRedisClient(env.REDIS_URL);
  const queue = new RedisTickQueue({ producer: queueProducer, subscriber: queueSubscriber });

  const privyAuth = new PrivyAuth({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
  const walletProvisioner = new WalletProvisioner({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    db,
  });

  const api = new ApiServer({
    db,
    activityLog,
    queue,
    privyAuth,
    walletProvisioner,
    port: env.PORT,
    ...(env.API_CORS_ORIGINS ? { corsOrigins: env.API_CORS_ORIGINS } : {}),
  });

  console.log(`[bootstrap] server — postgres at ${env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bootstrap] server — redis at ${env.REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
  await api.start();

  const shutdown = async (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping`);
    await api.stop().catch(() => {});
    await activityBus.close().catch(() => {});
    await queueProducer.quit().catch(() => {});
    await queueSubscriber.quit().catch(() => {});
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
```

**Verify constructor shapes:** `PrivyAuth` and `WalletProvisioner` are imported here exactly as `src/index.ts` (pre-Task-7) imported them. If their constructors differ, mirror what `index.ts` did before this task. (Read `src/index.ts` after Task 2 to confirm exact construction args, then mirror them here.)

- [ ] **Step 3: Delete `src/index.ts`**

```bash
git rm src/index.ts
```

- [ ] **Step 4: Update `package.json` scripts**

In `package.json` `scripts`:

- Remove: `start`, `start:looper`, `start:server`, `dev`, `dev:looper`, `dev:server`
- Add:
  - `"start:worker": "NODE_OPTIONS=--conditions=require tsx src/worker.ts"`
  - `"start:server": "NODE_OPTIONS=--conditions=require tsx src/server.ts"`
  - `"dev:worker": "NODE_OPTIONS=--conditions=require tsx watch src/worker.ts"`
  - `"dev:server": "NODE_OPTIONS=--conditions=require tsx watch src/server.ts"`

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: passes. If `WalletProvisioner` / `PrivyAuth` constructors don't match the args used in `server.ts`, fix `server.ts` to match the real constructors (don't change the classes).

- [ ] **Step 6: Smoke test the worker**

In one terminal:

```bash
docker compose up -d postgres redis
npm run db:migrate
npm run db:seed
REDIS_URL=redis://localhost:6379 npm run start:worker
```

Expected: scheduler logs `[worker] tick @ ...` every 10s. The seeded UNI MA agent's lastTickAt advances. Stop with Ctrl-C; should see clean shutdown logs.

- [ ] **Step 7: Smoke test the server**

In another terminal (worker still running):

```bash
REDIS_URL=redis://localhost:6379 PRIVY_APP_ID=dummy PRIVY_APP_SECRET=dummy npm run start:server
```

Expected: `[api-server] listening on http://localhost:3000`.

```bash
curl -s http://localhost:3000/openapi.json | head -1
```

Expected: starts with `{"openapi":"3.1.0",…}`.

- [ ] **Step 8: Run full test suite**

```bash
REDIS_URL=redis://localhost:6379 npm test
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(processes): split monolith into worker.ts + server.ts entries; remove MODE"
```

---

## Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "API Server" section + scripts table**

Find the section `## API Server` in `README.md` and replace it (and the `Scripts` table that mentions `npm start`) with:

````markdown
## Processes

The agent loop runs as **two independent processes** sharing Postgres + Redis:

```bash
npm run start:worker    # scheduler + tick dispatcher (no HTTP)
npm run start:server    # Express API + SSE (no scheduler)
```

Both processes can run on different machines / containers. Communication:

- **Postgres** — durable state (agents, transactions, positions, memory, activity log)
- **Redis LIST** (`agent-loop:queue`) — tick payloads enqueued by either process; consumed by worker via `BRPOP`
- **Redis pub/sub** (`agent-loop:activity:<agentId>`) — activity-log events published by the worker; subscribed by the server for SSE delivery

Either process can crash/restart without losing durable state. In-flight ticks consumed via `BRPOP` are not requeued on worker crash (at-most-once); chat messages can be retried by the client.

CORS allow-list via `API_CORS_ORIGINS` (CSV; omit for `*`). Privy creds (`PRIVY_APP_ID` + `PRIVY_APP_SECRET`) are required by the server only.

## Scripts

| Command | What |
|---|---|
| `npm run start:worker` | scheduler + tick dispatcher process |
| `npm run start:server` | API + SSE process |
| `npm run dev:worker` / `npm run dev:server` | tsx watch mode |
| `npm test` / `npm run typecheck` / `npm run build` | dev loops; safe to run any time |
| `npm run zerog-bootstrap` | list / fund 0G inference provider |
| `npm run llm:probe` | sanity-check the LLM round trip |
| `npm run swap:buy-uni` / `npm run swap:sell-uni` | manual UNI/USDC swap on Unichain |
| `npm run db:up` / `db:down` / `db:nuke` | Postgres + Redis docker lifecycle |
| `npm run db:migrate` / `db:seed` / `db:reset` / `db:studio` | Prisma lifecycle |
````

- [ ] **Step 2: Update Setup + Run sections**

Replace the `## Setup` and `## Run` blocks at the top:

````markdown
## Setup

```bash
npm install
cp .env.example .env  # fill in keys (WALLET_PRIVATE_KEY, ALCHEMY_API_KEY, ZEROG_NETWORK, REDIS_URL, DATABASE_URL, etc.)
docker compose up -d postgres redis
npm run db:migrate
npm run db:seed
```

## Run

```bash
# 1. fund a 0G inference provider (one-time, ~3 OG)
npm run zerog-bootstrap          # lists providers
# set ZEROG_PROVIDER_ADDRESS=0x... in .env
npm run zerog-bootstrap          # this run actually funds + persists

# 2. run the two processes (separate terminals)
npm run start:worker
npm run start:server
```
````

- [ ] **Step 3: Update the `## Layout` block**

Replace the `agent-looper/` line in the `Layout` section with `agent-worker/`. Add `redis/`. Final block:

```
src/
  agent-worker/  agent-runner/  database/
  ai/{zerog-broker, chat-model}/  ai-tools/
  uniswap/  wallet/{real, dry-run, factory, privy}/
  providers/  redis/  api-server/  constants/  config/
  worker.ts  server.ts
scripts/         operator commands (anything that spends money)
```

- [ ] **Step 4: Update the "TickQueue — single-worker FIFO" section**

Replace the section in README that says "single-process only, lost on restart … Run MODE=both …". New text:

````markdown
### Tick queue — Redis-backed FIFO

A single Redis LIST (`agent-loop:queue`) serializes all tick execution (scheduled + chat) across the whole system. Both processes can enqueue:

- **Scheduled ticks** — the worker's orchestrator enqueues a payload per due agent and bumps `lastTickAt` optimistically so subsequent looper iterations don't pile up duplicates.
- **Chat POSTs** — `POST /agents/:id/messages` on the server enqueues a `chat` payload immediately and returns `202 { position }`.

The worker's `TickDispatcher` `BRPOP`s the list and runs payloads sequentially via `AgentRunner`. To horizontally scale, run multiple workers — Redis `BRPOP` guarantees each payload is delivered to exactly one worker.

Chat clients subscribe to `GET /agents/:id/stream` to observe progress. Ephemeral events (`task_queued`, `task_started`, `token`, `task_finished`) and persisted events (`tick_start`, `llm_call`, `tool_call`, `tool_result`, `llm_response`, `tick_end`) all flow through Redis pub/sub channel `agent-loop:activity:<agentId>` from the worker (publisher) to the server (subscriber).
````

- [ ] **Step 5: Update README env block to mention REDIS_URL**

The "Setup" + "Env" sections of `CLAUDE.md` already get updated separately; in `README.md` no env block exists today, so just verify the bullet in the new "Setup" section mentions `REDIS_URL`.

- [ ] **Step 6: Update `CLAUDE.md` env block**

In the `## Env` section of `CLAUDE.md`, append `REDIS_URL=` under `# Postgres` block (or under a new `# Redis` block):

```
# Redis (queue + activity bus)
REDIS_URL=
```

And remove (if present) any `MODE=` reference.

- [ ] **Step 7: Run typecheck + tests one final time**

```bash
npm run typecheck
REDIS_URL=redis://localhost:6379 npm test
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: document worker/server split + redis-backed queue and activity bus"
```

---

## Task 8: End-to-end smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Boot the full stack**

Three terminals:

```bash
# Terminal A
docker compose up -d postgres redis
npm run db:reset

# Terminal B
REDIS_URL=redis://localhost:6379 npm run start:worker

# Terminal C
REDIS_URL=redis://localhost:6379 PRIVY_APP_ID=dummy PRIVY_APP_SECRET=dummy npm run start:server
```

- [ ] **Step 2: Watch the worker log**

In Terminal B: confirm `[worker] tick @ ...` appears every 10s and the seed agent's `lastTickAt` advances. After one tick, you should see entries in Postgres:

```bash
docker compose exec postgres psql -U postgres -d agent_loop -c "select agent_id, type, timestamp from activity_log order by timestamp desc limit 5;"
```

Expected: at least one `tick_start` and `tick_end` row.

- [ ] **Step 3: Verify Redis is being used**

```bash
docker compose exec redis redis-cli LLEN agent-loop:queue
```

Expected: 0 most of the time (queue drains fast). Run repeatedly — values >0 will appear momentarily right after each scheduler tick.

```bash
docker compose exec redis redis-cli PUBSUB CHANNELS 'agent-loop:activity:*'
```

Expected: empty until the server has an active SSE subscriber, then you'll see `agent-loop:activity:<agentId>`.

- [ ] **Step 4: Sanity-check the SSE flow**

This step requires either a real Privy JWT or temporarily disabling auth. Skip this step if no test JWT is available — the worker→server pub/sub path is already covered by the `RedisActivityBus` live test.

- [ ] **Step 5: Tear down**

```bash
# Terminals B + C: Ctrl-C
# Terminal A:
docker compose down
```

- [ ] **Step 6: Final commit (if any docs adjustments shook out)**

If any further tweaks were needed, commit them. Otherwise, no commit.

```bash
git status
```

Expected: clean.

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Rename looper → worker (Task 1)
- ✅ Remove coupling (separate scripts, separate processes) (Task 6)
- ✅ Use redis for queue (Tasks 2, 5)
- ✅ Update docker (Task 2)
- ✅ Update .env.example (Task 2)
- ✅ Update README (Task 7)
- ✅ Both processes can add new queue tasks (server enqueues chat payloads via `POST /agents/:id/messages`; worker enqueues scheduled payloads via orchestrator) (Tasks 3, 5, 6)

**Type consistency:**
- `IntervalScheduler` (Task 1) used in `worker.ts` (Task 6) ✓
- `WORKER.tickIntervalMs` (Task 1) used in `worker.ts` (Task 6) ✓
- `TickPayload` (Task 3) referenced by `RedisTickQueue` (Task 5) ✓
- `ActivityBus` (Task 4) consumed by `AgentActivityLog` (Task 4) and provided by `RedisActivityBus` (Task 5) ✓
- `TickQueue.hasScheduledFor` is async after Task 3 — `AgentOrchestrator` awaits it ✓
- `AgentOrchestrator` constructor reduced to `(db, queue, clock?)` after Task 3 — every call site (test, `worker.ts`) matches ✓
- `ApiServerDeps` no longer includes `runner` after Task 3 — `server.ts` constructs it without ✓

**Risks called out:**
- `ioredis` `BRPOP` blocks the connection — that's why both `RedisTickQueue` and `RedisActivityBus` take a dedicated subscriber connection. (Task 5 inline notes.)
- `at-most-once` worker delivery (Task 7 README): payload BRPOPped and crashed worker = lost. Acceptable for v1; chat clients can retry, scheduled ticks self-heal next interval.
- The single `dispatcher` consumes payloads sequentially. To scale, run multiple worker processes — each `BRPOP`s the same list. Per-agent ordering is no longer guaranteed across multiple workers, but per-agent overlap is prevented today only by `hasScheduledFor` (a check-then-enqueue race that already existed). Documenting horizontal scaling beyond v1 is out of scope.
