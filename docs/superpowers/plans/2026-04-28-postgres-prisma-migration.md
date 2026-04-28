# Postgres + Prisma Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `FileDatabase` and `FileActivityLogStore` with a single Prisma + Postgres implementation. Fold `src/agent-activity-log/` into `src/database/`. Add Docker Compose for local Postgres, npm scripts for DB lifecycle, and a `prisma/seed.ts` that replaces the old `scripts/seed-agent.ts`. End state: `npm run db:up && npm run db:migrate && npm run db:seed && npm start` boots the looper against Postgres with the seed agent installed.

**Architecture:** Storage swap behind the existing `Database` facade. Repository interfaces and domain types stay; only implementations change. `ActivityLogStore` is renamed `ActivityLogRepository` and joins `Database`. The high-level `AgentActivityLog` facade (EventEmitter + typed write helpers) stays — moves to `src/database/agent-activity-log.ts`. Local Postgres 16 runs in Docker Compose; production target is Supabase. Two databases on one container: `agent_loop` (dev), `agent_loop_test` (live tests).

**Tech Stack:** TypeScript 5.x, Node 20+, Prisma 5.x, Postgres 16 (Docker locally), vitest (live tests).

**Spec reference:** [docs/superpowers/specs/2026-04-28-postgres-prisma-migration-design.md](../specs/2026-04-28-postgres-prisma-migration-design.md)

**Test rule:** Live tests against real Postgres at `TEST_DATABASE_URL`. Tests skip themselves when the env var is missing. `npm test` stays safe (no Postgres = skip, not fail). Same `*.live.test.ts` style as the rest of the project: assert sensible shape, `console.log` payload for human eyeballing.

---

## File Structure

```
prisma/
  schema.prisma                                  # Prisma datasource + generator + 6 models
  migrations/                                    # auto-generated; commit to git
  seed.ts                                        # replaces scripts/seed-agent.ts logic

docker-compose.yml                               # postgres:16, named volume, port 5432
docker/postgres-init/
  01-create-test-db.sql                          # creates agent_loop_test on first boot

src/database/
  database.ts                                    # interface; gains `activityLog`
  types.ts                                       # all domain types incl. AgentActivityLogEntry
  agent-activity-log.ts                          # facade (moved from src/agent-activity-log/)
  repositories/
    agent-repository.ts                          # unchanged
    transaction-repository.ts                    # unchanged
    position-repository.ts                       # unchanged
    agent-memory-repository.ts                   # unchanged
    activity-log-repository.ts                   # was activity-log-store.ts; interface renamed
  prisma-database/
    prisma-database.ts                           # holds PrismaClient, exposes 5 repos
    prisma-agent-repository.ts
    prisma-transaction-repository.ts
    prisma-position-repository.ts
    prisma-agent-memory-repository.ts
    prisma-activity-log-repository.ts
    mappers.ts                                   # row ↔ domain conversions
    test-helpers.ts                              # truncate-all + skip-if-no-env helpers
    prisma-database.live.test.ts                 # round-trip all 4 core repos
    prisma-activity-log-repository.live.test.ts  # append, list, ordering, sinceTickId

# Deleted
src/agent-activity-log/                          # entire directory
src/database/file-database/                      # entire directory (after Prisma cutover)
scripts/seed-agent.ts
scripts/reset-db.ts

# Modified
src/index.ts                                     # constructs PrismaDatabase + activityLog
src/config/env.ts                                # adds DATABASE_URL, TEST_DATABASE_URL
.env.example                                     # adds DATABASE_URL, TEST_DATABASE_URL
package.json                                     # adds prisma deps + db:* scripts; removes old
.gitignore                                       # ensure prisma/migrations/ is tracked
CLAUDE.md                                        # updates module separation note
```

---

## Phase 0 — Domain cleanup

### Task 0: Remove dead `AgentConfig.walletAddress` field

`walletAddress` is written by every fixture, the seed factory, and the API create-agent route, but no code path reads it — the active wallet comes from `WALLET_PRIVATE_KEY` via `WalletFactory`. Removing it now keeps the new Prisma schema clean.

**Files:**
- Modify: [src/database/types.ts](../../../src/database/types.ts)
- Modify: [src/api-server/openapi/schemas.ts](../../../src/api-server/openapi/schemas.ts)
- Modify: [src/api-server/routes/agents.ts](../../../src/api-server/routes/agents.ts)
- Modify: [scripts/lib/seed-uni-ma-trader.ts](../../../scripts/lib/seed-uni-ma-trader.ts)
- Modify: [scripts/lib/swap-runner.ts](../../../scripts/lib/swap-runner.ts)
- Modify: [src/database/file-database/file-database.live.test.ts](../../../src/database/file-database/file-database.live.test.ts)
- Modify: [src/wallet/dry-run/dry-run-wallet.live.test.ts](../../../src/wallet/dry-run/dry-run-wallet.live.test.ts)
- Modify: [src/wallet/factory/wallet-factory.live.test.ts](../../../src/wallet/factory/wallet-factory.live.test.ts)
- Modify: [src/agent-looper/agent-orchestrator.live.test.ts](../../../src/agent-looper/agent-orchestrator.live.test.ts)
- Modify: [src/agent-runner/agent-runner.live.test.ts](../../../src/agent-runner/agent-runner.live.test.ts)
- Modify: [src/ai-tools/tool-registry.live.test.ts](../../../src/ai-tools/tool-registry.live.test.ts)

- [ ] **Step 1: Remove field from `AgentConfig`**

In `src/database/types.ts`, delete the `walletAddress: string;` line from `AgentConfig`.

- [ ] **Step 2: Remove from API server schemas**

In `src/api-server/openapi/schemas.ts`:
- Delete the `walletAddress: z.string()` line from the agent response schema.
- Delete the `walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/)` line from the create-agent request schema.

- [ ] **Step 3: Remove from create-agent route**

In `src/api-server/routes/agents.ts`, find the line `walletAddress: body.walletAddress,` (around line 37) and delete it from the `AgentConfig` literal being constructed.

- [ ] **Step 4: Remove from seed factory and swap-runner**

In `scripts/lib/seed-uni-ma-trader.ts`, delete the `walletAddress: '',` line.

In `scripts/lib/swap-runner.ts`, delete the `walletAddress: wallet.getAddress(),` line.

- [ ] **Step 5: Remove from every test fixture**

Run: `grep -rn "walletAddress: '" src/ --include="*.ts"`

For each match (file-database test, dry-run-wallet test, wallet-factory test, agent-orchestrator test, agent-runner test, tool-registry test), delete the `walletAddress: '...'` line from the agent fixture.

- [ ] **Step 6: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck passes; all unit and live tests still pass.

- [ ] **Step 7: Verify nothing else references it**

Run: `grep -rn "walletAddress" src/ scripts/ --include="*.ts" | grep -v "wallet.address\|walletAddress:" | grep -v "buildZeroGBroker\|broker-factory"`
Expected: no matches related to `AgentConfig.walletAddress`. The remaining hits are the 0G broker's wallet address, which is unrelated.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(agent): remove dead AgentConfig.walletAddress field

The field was written by every fixture/factory/route but never read.
WalletFactory derives the address from WALLET_PRIVATE_KEY directly."
```

---

## Phase A — Restructure: fold `agent-activity-log/` into `database/`

No behavior change in this phase. Pure file moves + rename. Type-checking + existing tests stay green throughout.

### Task 1: Move activity-log types into `src/database/types.ts`

**Files:**
- Modify: [src/database/types.ts](../../../src/database/types.ts)
- Delete (later, in task 5): `src/agent-activity-log/types.ts`

- [ ] **Step 1: Append activity-log types to `src/database/types.ts`**

```typescript
// at the bottom of src/database/types.ts
export type AgentActivityLogEntryType =
  | 'user_message'
  | 'tick_start'
  | 'tick_end'
  | 'tool_call'
  | 'tool_result'
  | 'llm_call'
  | 'llm_response'
  | 'memory_update'
  | 'error';

export interface AgentActivityLogEntryInput {
  agentId: string;
  tickId: string;
  timestamp: number;
  type: AgentActivityLogEntryType;
  payload: Record<string, unknown>;
}

export interface AgentActivityLogEntry extends AgentActivityLogEntryInput {
  seq: number;
}
```

- [ ] **Step 2: Update `src/agent-activity-log/types.ts` to re-export from new home (transitional)**

```typescript
// src/agent-activity-log/types.ts
export type {
  AgentActivityLogEntry,
  AgentActivityLogEntryInput,
  AgentActivityLogEntryType,
} from '../database/types';
```

This keeps existing imports working while we move the rest of the module.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/database/types.ts src/agent-activity-log/types.ts
git commit -m "refactor(activity-log): move types into src/database/types.ts"
```

---

### Task 2: Rename `ActivityLogStore` → `ActivityLogRepository`, move to `src/database/repositories/`

**Files:**
- Create: [src/database/repositories/activity-log-repository.ts](../../../src/database/repositories/activity-log-repository.ts)
- Modify: `src/agent-activity-log/activity-log-store.ts` (becomes shim)

- [ ] **Step 1: Create the new repository file**

```typescript
// src/database/repositories/activity-log-repository.ts
import type {
  AgentActivityLogEntry,
  AgentActivityLogEntryInput,
} from '../types';

export interface ActivityLogRepository {
  append(entry: AgentActivityLogEntryInput): Promise<AgentActivityLogEntry>;
  listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]>;
}
```

- [ ] **Step 2: Replace old `activity-log-store.ts` with a re-export shim**

```typescript
// src/agent-activity-log/activity-log-store.ts
export type { ActivityLogRepository as ActivityLogStore } from '../database/repositories/activity-log-repository';
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/database/repositories/activity-log-repository.ts src/agent-activity-log/activity-log-store.ts
git commit -m "refactor(activity-log): rename ActivityLogStore to ActivityLogRepository, move under database/"
```

---

### Task 3: Move `AgentActivityLog` facade to `src/database/agent-activity-log.ts`

**Files:**
- Create: [src/database/agent-activity-log.ts](../../../src/database/agent-activity-log.ts)
- Modify: `src/agent-activity-log/agent-activity-log.ts` (becomes shim)

- [ ] **Step 1: Create new facade file**

Copy the entire current contents of `src/agent-activity-log/agent-activity-log.ts` to `src/database/agent-activity-log.ts`, but rewrite imports:

```typescript
// src/database/agent-activity-log.ts
import { EventEmitter } from 'node:events';
import type { ActivityLogRepository } from './repositories/activity-log-repository';
import type { AgentActivityLogEntry, AgentActivityLogEntryType } from './types';

export type AgentActivityEvent =
  | { kind: 'append'; entry: AgentActivityLogEntry }
  | { kind: 'ephemeral'; agentId: string; payload: Record<string, unknown> };

export class AgentActivityLog {
  private readonly emitter = new EventEmitter();

  constructor(private readonly repo: ActivityLogRepository) {
    this.emitter.setMaxListeners(100);
  }

  on(agentId: string, listener: (event: AgentActivityEvent) => void): () => void {
    const eventName = `agent:${agentId}`;
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }

  emitEphemeral(agentId: string, payload: Record<string, unknown>): void {
    this.emitter.emit(`agent:${agentId}`, { kind: 'ephemeral', agentId, payload });
  }

  tickStart(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_start', payload);
  }

  tickEnd(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_end', payload);
  }

  userMessage(
    agentId: string,
    tickId: string,
    payload: { content: string },
  ): Promise<void> {
    return this.write(agentId, tickId, 'user_message', payload);
  }

  toolCall(
    agentId: string,
    tickId: string,
    payload: { id: string; tool: string; input: unknown },
  ): Promise<void> {
    return this.write(agentId, tickId, 'tool_call', payload);
  }

  toolResult(
    agentId: string,
    tickId: string,
    payload: { id: string; tool: string; output: unknown; durationMs: number },
  ): Promise<void> {
    return this.write(agentId, tickId, 'tool_result', payload);
  }

  llmCall(
    agentId: string,
    tickId: string,
    payload: { model: string; promptChars: number },
  ): Promise<void> {
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
    this.emitter.emit(`agent:${agentId}`, { kind: 'append', entry } satisfies AgentActivityEvent);
  }
}
```

- [ ] **Step 2: Replace old facade with re-export shim**

```typescript
// src/agent-activity-log/agent-activity-log.ts
export { AgentActivityLog, type AgentActivityEvent } from '../database/agent-activity-log';
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: passes (existing `file-activity-log-store.live.test.ts` still works via the shim).

- [ ] **Step 4: Commit**

```bash
git add src/database/agent-activity-log.ts src/agent-activity-log/agent-activity-log.ts
git commit -m "refactor(activity-log): move AgentActivityLog facade under src/database/"
```

---

### Task 4: Move `FileActivityLogStore` under `src/database/file-database/` and rename

**Files:**
- Create: `src/database/file-database/file-activity-log-repository.ts`
- Create: `src/database/file-database/file-activity-log-repository.live.test.ts` (moved from `src/agent-activity-log/`)
- Modify: `src/agent-activity-log/file-activity-log-store.ts` (becomes shim)
- Delete: (later, task 5) `src/agent-activity-log/file-activity-log-store.live.test.ts`

This file is going to be deleted entirely in Phase D, but we move it under `file-database/` now so all file-backed code lives in one place during the transition.

- [ ] **Step 1: Create the new file under `file-database/`**

```typescript
// src/database/file-database/file-activity-log-repository.ts
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import type { AgentActivityLogEntry, AgentActivityLogEntryInput } from '../types';

export class FileActivityLogRepository implements ActivityLogRepository {
  private readonly seqByAgent = new Map<string, number>();

  constructor(private readonly dbDir: string) {}

  private async nextSeq(agentId: string): Promise<number> {
    if (!this.seqByAgent.has(agentId)) {
      try {
        const raw = await readFile(this.pathFor(agentId), 'utf8');
        const lines = raw.split('\n').filter((l) => l.length > 0);
        this.seqByAgent.set(agentId, lines.length);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.seqByAgent.set(agentId, 0);
        } else {
          throw err;
        }
      }
    }
    const cur = (this.seqByAgent.get(agentId) ?? 0) + 1;
    this.seqByAgent.set(agentId, cur);
    return cur;
  }

  async append(entry: AgentActivityLogEntryInput): Promise<AgentActivityLogEntry> {
    const path = this.pathFor(entry.agentId);
    await mkdir(dirname(path), { recursive: true });
    const seq = await this.nextSeq(entry.agentId);
    const final: AgentActivityLogEntry = { ...entry, seq };
    await appendFile(path, JSON.stringify(final) + '\n', 'utf8');
    return final;
  }

  async listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(agentId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);
    let entries = lines.map((l) => JSON.parse(l) as AgentActivityLogEntry);

    if (opts?.sinceTickId) {
      let lastIdx = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.tickId === opts.sinceTickId) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx >= 0) entries = entries.slice(lastIdx + 1);
    }

    if (typeof opts?.limit === 'number') {
      entries = entries.slice(-opts.limit);
    }

    return entries;
  }

  private pathFor(agentId: string): string {
    return join(this.dbDir, 'activity-log', `${agentId}.json`);
  }
}
```

- [ ] **Step 2: Move + rewrite the live test file**

Copy `src/agent-activity-log/file-activity-log-store.live.test.ts` to `src/database/file-database/file-activity-log-repository.live.test.ts`, replacing the import + class name:

```typescript
// at top of new file
import { FileActivityLogRepository } from './file-activity-log-repository';
// ... rest of test, replacing every `new FileActivityLogStore(` with `new FileActivityLogRepository(`
```

- [ ] **Step 3: Replace old file with shim, delete old test**

```typescript
// src/agent-activity-log/file-activity-log-store.ts
export { FileActivityLogRepository as FileActivityLogStore } from '../database/file-database/file-activity-log-repository';
```

```bash
rm src/agent-activity-log/file-activity-log-store.live.test.ts
```

- [ ] **Step 4: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/database/file-database/file-activity-log-repository.ts \
        src/database/file-database/file-activity-log-repository.live.test.ts \
        src/agent-activity-log/file-activity-log-store.ts
git rm src/agent-activity-log/file-activity-log-store.live.test.ts
git commit -m "refactor(activity-log): move FileActivityLogStore under database/file-database/ and rename"
```

---

### Task 5: Add `activityLog` to `Database` interface, expose from `FileDatabase`, rewire `index.ts`

**Files:**
- Modify: [src/database/database.ts](../../../src/database/database.ts)
- Modify: [src/database/file-database/file-database.ts](../../../src/database/file-database/file-database.ts)
- Modify: [src/index.ts](../../../src/index.ts)
- Modify: imports across codebase referencing `AgentActivityLog` or `FileActivityLogStore`

- [ ] **Step 1: Add `activityLog` field to `Database` interface**

```typescript
// src/database/database.ts
import type { AgentRepository } from './repositories/agent-repository';
import type { TransactionRepository } from './repositories/transaction-repository';
import type { PositionRepository } from './repositories/position-repository';
import type { AgentMemoryRepository } from './repositories/agent-memory-repository';
import type { ActivityLogRepository } from './repositories/activity-log-repository';

export interface Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;
}
```

- [ ] **Step 2: Update `FileDatabase` to expose `activityLog`**

```typescript
// src/database/file-database/file-database.ts
import type { Database } from '../database';
import type { AgentRepository } from '../repositories/agent-repository';
import type { TransactionRepository } from '../repositories/transaction-repository';
import type { PositionRepository } from '../repositories/position-repository';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import { FileAgentRepository } from './file-agent-repository';
import { FileTransactionRepository } from './file-transaction-repository';
import { FilePositionRepository } from './file-position-repository';
import { FileAgentMemoryRepository } from './file-agent-memory-repository';
import { FileActivityLogRepository } from './file-activity-log-repository';

export class FileDatabase implements Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;

  constructor(dbDir: string) {
    this.agents = new FileAgentRepository(dbDir);
    this.transactions = new FileTransactionRepository(dbDir);
    this.positions = new FilePositionRepository(dbDir);
    this.agentMemory = new FileAgentMemoryRepository(dbDir);
    this.activityLog = new FileActivityLogRepository(dbDir);
  }
}
```

- [ ] **Step 3: Rewire `src/index.ts` to construct `AgentActivityLog` from `db.activityLog`**

In `src/index.ts`, replace the imports + activityLog construction:

```typescript
// remove: import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
// remove: import { AgentActivityLog } from './agent-activity-log/agent-activity-log';
// add:    import { AgentActivityLog } from './database/agent-activity-log';

// in main():
const db = new FileDatabase(env.DB_DIR);
const activityLog = new AgentActivityLog(db.activityLog);   // was: new AgentActivityLog(new FileActivityLogStore(env.DB_DIR));
```

- [ ] **Step 4: Sweep all other files importing from `src/agent-activity-log/`**

Run: `grep -rn "from.*agent-activity-log" src/ scripts/ --include="*.ts"`

Update each import to point to `src/database/agent-activity-log` (for the facade) or `src/database/types` (for the entry types). Examples:

```typescript
// Before:
import { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
// After:
import { AgentActivityLog } from '../database/agent-activity-log';

// Before:
import type { AgentActivityLogEntry } from '../agent-activity-log/types';
// After:
import type { AgentActivityLogEntry } from '../database/types';
```

The shim files in `src/agent-activity-log/` will still work, but rewriting consumers makes Task 5 (delete shims) clean.

- [ ] **Step 5: Verify typecheck + tests + smoke**

Run: `npm run typecheck && npm test && npm start`
Expected: typecheck passes; tests pass; `npm start` boots, looper ticks, activity log writes to `db/activity-log/<agentId>.json` (Ctrl-C after one tick).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(database): expose activityLog repository from Database; rewire imports"
```

---

### Task 6: Delete the now-empty `src/agent-activity-log/` directory

**Files:**
- Delete: `src/agent-activity-log/` (entire directory)

- [ ] **Step 1: Confirm only shim files remain**

Run: `ls src/agent-activity-log/`
Expected: `activity-log-store.ts`, `agent-activity-log.ts`, `file-activity-log-store.ts`, `types.ts` (all shims).

- [ ] **Step 2: Confirm no consumer imports them**

Run: `grep -rn "agent-activity-log/" src/ scripts/ --include="*.ts"`
Expected: no matches (Task 5 step 4 should have rewritten everything).

- [ ] **Step 3: Delete the directory**

```bash
git rm -r src/agent-activity-log/
```

- [ ] **Step 4: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(activity-log): delete src/agent-activity-log/ directory; folded into src/database/"
```

---

## Phase B — Postgres infrastructure

### Task 7: Add Docker Compose + test-DB init script

**Files:**
- Create: [docker-compose.yml](../../../docker-compose.yml)
- Create: [docker/postgres-init/01-create-test-db.sql](../../../docker/postgres-init/01-create-test-db.sql)

- [ ] **Step 1: Create `docker-compose.yml`**

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

volumes:
  agent-loop-pgdata:
```

- [ ] **Step 2: Create the init SQL**

```sql
-- docker/postgres-init/01-create-test-db.sql
-- Runs once on first container start (when the data volume is empty).
CREATE DATABASE agent_loop_test;
```

- [ ] **Step 3: Bring up the stack and verify both DBs exist**

```bash
docker compose up -d postgres
docker compose exec postgres pg_isready -U postgres   # should report accepting connections
docker compose exec postgres psql -U postgres -l      # should list agent_loop AND agent_loop_test
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docker/postgres-init/
git commit -m "feat(infra): add Docker Compose Postgres 16 service with test DB init"
```

---

### Task 8: Add `DATABASE_URL` + `TEST_DATABASE_URL` to env config

**Files:**
- Modify: [src/config/env.ts](../../../src/config/env.ts)
- Modify: [.env.example](../../../.env.example)
- Modify: [.env](../../../.env) (the implementer's local file — DO NOT commit `.env`)

- [ ] **Step 1: Update `env.ts` zod schema**

Add `DATABASE_URL` (required) and `TEST_DATABASE_URL` (optional) to the schema:

```typescript
// in src/config/env.ts, inside z.object({ ... })
DATABASE_URL: z.string().url(),
TEST_DATABASE_URL: z.string().url().optional(),
```

- [ ] **Step 2: Update `.env.example`**

Append to `.env.example`:

```
# Postgres (local Docker; production = Supabase)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test
```

- [ ] **Step 3: Add the same lines to local `.env`**

(Manually, in the implementer's `.env`. Do not commit.)

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat(config): require DATABASE_URL; optional TEST_DATABASE_URL for live tests"
```

---

### Task 9: Install Prisma + create initial `schema.prisma`

**Files:**
- Modify: [package.json](../../../package.json)
- Create: [prisma/schema.prisma](../../../prisma/schema.prisma)

- [ ] **Step 1: Install Prisma**

```bash
npm install --save-dev prisma
npm install @prisma/client
```

- [ ] **Step 2: Initialize Prisma**

```bash
npx prisma init --datasource-provider postgresql --output ../node_modules/.prisma/client
```

This creates `prisma/schema.prisma` with a stub. Replace its contents with:

- [ ] **Step 3: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Agent {
  id                  String   @id
  name                String
  prompt              String
  dryRun              Boolean
  dryRunSeedBalances  Json?
  riskLimits          Json
  createdAt           BigInt
  running             Boolean?
  intervalMs          Int?
  lastTickAt          BigInt?

  transactions        Transaction[]
  positions           Position[]
  memory              AgentMemory?
  events              ActivityEvent[]
}

model Transaction {
  id            String   @id
  agentId       String
  agent         Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  hash          String
  chainId       Int
  from          String
  to            String
  tokenIn       Json?
  tokenOut      Json?
  gasUsed       String
  gasPriceWei   String
  gasCostWei    String
  status        String
  blockNumber   BigInt?
  timestamp     BigInt

  @@index([agentId, timestamp])
}

model Position {
  id                       String    @id
  agentId                  String
  agent                    Agent     @relation(fields: [agentId], references: [id], onDelete: Cascade)
  amount                   Json
  costBasisUSD             Float
  openedByTransactionId    String
  closedByTransactionId    String?
  openedAt                 BigInt
  closedAt                 BigInt?
  realizedPnlUSD           Float?

  @@index([agentId, closedAt])
}

model AgentMemory {
  agentId     String        @id
  agent       Agent         @relation(fields: [agentId], references: [id], onDelete: Cascade)
  notes       String        @default("")
  state       Json
  updatedAt   BigInt

  entries     MemoryEntry[]
}

model MemoryEntry {
  id              String      @id
  agentId         String
  memory          AgentMemory @relation(fields: [agentId], references: [agentId], onDelete: Cascade)
  tickId          String
  type            String
  content         String
  parentEntryIds  String[]
  createdAt       BigInt

  @@index([agentId, createdAt])
  @@index([agentId, tickId])
}

model ActivityEvent {
  id          String   @id
  agentId     String
  agent       Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  tickId      String?
  type        String
  level       String
  payload     Json
  timestamp   BigInt
  seq         BigInt   @default(autoincrement()) @unique

  @@index([agentId, timestamp])
  @@index([agentId, tickId])
  @@index([agentId, seq])
}
```

- [ ] **Step 4: Verify schema is valid**

```bash
npx prisma validate
```

Expected: "The schema at prisma/schema.prisma is valid."

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json prisma/schema.prisma
git commit -m "feat(db): add Prisma + initial schema (Agent, Transaction, Position, AgentMemory, MemoryEntry, ActivityEvent)"
```

---

### Task 10: Add `db:*` npm scripts and `prisma.seed` config

**Files:**
- Modify: [package.json](../../../package.json)

- [ ] **Step 1: Add scripts section entries**

In `package.json`, inside `"scripts"`, add:

```jsonc
"db:up":             "docker compose up -d postgres",
"db:down":           "docker compose down",
"db:nuke":           "docker compose down -v",
"db:logs":           "docker compose logs -f postgres",
"db:migrate":        "prisma migrate dev",
"db:migrate:deploy": "prisma migrate deploy",
"db:generate":       "prisma generate",
"db:studio":         "prisma studio",
"db:reset":          "prisma migrate reset",
"db:seed":           "NODE_OPTIONS=--conditions=require tsx prisma/seed.ts"
```

Remove the old scripts: `seed-agent`, `reset-db`.

- [ ] **Step 2: Add top-level `prisma` config block**

At the end of `package.json` (after `devDependencies`):

```jsonc
"prisma": {
  "seed": "NODE_OPTIONS=--conditions=require tsx prisma/seed.ts"
}
```

- [ ] **Step 3: Verify**

```bash
npm run db:generate
```

Expected: "Generated Prisma Client (...) to ./node_modules/@prisma/client".

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat(db): add db:* npm scripts; remove old seed-agent/reset-db scripts"
```

---

### Task 11: Run the first migration

**Files:**
- Create: `prisma/migrations/<timestamp>_init/migration.sql` (auto-generated)
- Create: `prisma/migrations/migration_lock.toml` (auto-generated)

- [ ] **Step 1: Generate + apply the initial migration**

```bash
npm run db:up        # ensure container is running
npm run db:migrate -- --name init
```

- [ ] **Step 2: Inspect the generated SQL**

Open `prisma/migrations/<timestamp>_init/migration.sql`. Confirm:
- `CREATE TABLE "Agent"` with all columns.
- `CREATE TABLE "ActivityEvent"` with `"seq" BIGSERIAL NOT NULL` (or equivalent autoincrement).
- All `@@index` declarations produce `CREATE INDEX` statements.

If `seq` did NOT become a `BIGSERIAL` (Prisma occasionally rejects `@default(autoincrement())` on non-id BigInt columns), edit the migration SQL by hand:
- Replace the `"seq" BIGINT NOT NULL` line with `"seq" BIGSERIAL NOT NULL`.
- Drop the migration's `CREATE UNIQUE INDEX "ActivityEvent_seq_key"` if it conflicts; `BIGSERIAL` already creates a sequence.

If you edit, re-apply by running `npm run db:reset` (it will re-create from scratch).

- [ ] **Step 3: Verify the schema in Postgres**

```bash
docker compose exec postgres psql -U postgres -d agent_loop -c "\d \"ActivityEvent\""
```

Expected: shows `seq` column with `nextval('"ActivityEvent_seq_seq"'::regclass)` default.

- [ ] **Step 4: Commit**

```bash
git add prisma/migrations/
git commit -m "feat(db): initial Prisma migration (Postgres schema)"
```

---

## Phase C — Prisma repositories (TDD)

Each Prisma repo gets a live test against `TEST_DATABASE_URL`. All tests share a setup helper that truncates tables in `beforeEach` and skips when the env var is missing.

### Task 12: Test infrastructure — setup file + truncate/skip helpers

**Files:**
- Create: `src/database/prisma-database/test-helpers.ts`

- [ ] **Step 1: Write the helpers**

```typescript
// src/database/prisma-database/test-helpers.ts
import { PrismaClient } from '@prisma/client';

let cached: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient | null {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  if (!cached) {
    cached = new PrismaClient({ datasources: { db: { url } } });
  }
  return cached;
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  // CASCADE handles FK relationships. Order doesn't matter with CASCADE.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ActivityEvent",
      "MemoryEntry",
      "AgentMemory",
      "Position",
      "Transaction",
      "Agent"
    RESTART IDENTITY CASCADE
  `);
}

export function describeIfPostgres(name: string, fn: () => void): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.log(`[skip] ${name} — TEST_DATABASE_URL not set`);
    return;
  }
  // Lazy require to avoid pulling vitest into prod bundle paths
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { describe } = require('vitest') as typeof import('vitest');
  describe(name, fn);
}
```

The `describeIfPostgres` helper means tests bail out before any `beforeEach` fires — `npm test` stays safe with no Postgres.

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/database/prisma-database/test-helpers.ts
git commit -m "feat(db): add Prisma test helpers (truncateAll, describeIfPostgres)"
```

---

### Task 13: `mappers.ts` — row ↔ domain conversions

**Files:**
- Create: `src/database/prisma-database/mappers.ts`

- [ ] **Step 1: Write the mappers**

```typescript
// src/database/prisma-database/mappers.ts
import type {
  Agent as PrismaAgent,
  Transaction as PrismaTransaction,
  Position as PrismaPosition,
  AgentMemory as PrismaAgentMemory,
  MemoryEntry as PrismaMemoryEntry,
  ActivityEvent as PrismaActivityEvent,
} from '@prisma/client';
import type {
  AgentConfig,
  Transaction,
  Position,
  AgentMemory,
  MemoryEntry,
  TokenAmount,
  AgentActivityLogEntry,
} from '../types';

const num = (v: bigint | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

const numReq = (v: bigint): number => Number(v);

export function agentRowToDomain(row: PrismaAgent): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    dryRun: row.dryRun,
    dryRunSeedBalances: (row.dryRunSeedBalances ?? undefined) as
      | Record<string, string>
      | undefined,
    riskLimits: row.riskLimits as AgentConfig['riskLimits'],
    createdAt: numReq(row.createdAt),
    running: row.running ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    lastTickAt: num(row.lastTickAt),
  };
}

export function agentDomainToRow(a: AgentConfig): {
  create: Omit<PrismaAgent, never>;
  update: Omit<PrismaAgent, 'id'>;
} {
  const base: Omit<PrismaAgent, 'id'> = {
    name: a.name,
    prompt: a.prompt,
    dryRun: a.dryRun,
    dryRunSeedBalances: (a.dryRunSeedBalances ?? null) as PrismaAgent['dryRunSeedBalances'],
    riskLimits: a.riskLimits as PrismaAgent['riskLimits'],
    createdAt: BigInt(a.createdAt),
    running: a.running ?? null,
    intervalMs: a.intervalMs ?? null,
    lastTickAt: a.lastTickAt === null || a.lastTickAt === undefined ? null : BigInt(a.lastTickAt),
  };
  return {
    create: { id: a.id, ...base },
    update: base,
  };
}

export function txRowToDomain(row: PrismaTransaction): Transaction {
  return {
    id: row.id,
    agentId: row.agentId,
    hash: row.hash,
    chainId: row.chainId,
    from: row.from,
    to: row.to,
    tokenIn: (row.tokenIn ?? undefined) as TokenAmount | undefined,
    tokenOut: (row.tokenOut ?? undefined) as TokenAmount | undefined,
    gasUsed: row.gasUsed,
    gasPriceWei: row.gasPriceWei,
    gasCostWei: row.gasCostWei,
    status: row.status as Transaction['status'],
    blockNumber: num(row.blockNumber),
    timestamp: numReq(row.timestamp),
  };
}

export function txDomainToCreate(t: Transaction): Omit<PrismaTransaction, never> {
  return {
    id: t.id,
    agentId: t.agentId,
    hash: t.hash,
    chainId: t.chainId,
    from: t.from,
    to: t.to,
    tokenIn: (t.tokenIn ?? null) as PrismaTransaction['tokenIn'],
    tokenOut: (t.tokenOut ?? null) as PrismaTransaction['tokenOut'],
    gasUsed: t.gasUsed,
    gasPriceWei: t.gasPriceWei,
    gasCostWei: t.gasCostWei,
    status: t.status,
    blockNumber: t.blockNumber === null ? null : BigInt(t.blockNumber),
    timestamp: BigInt(t.timestamp),
  };
}

export function positionRowToDomain(row: PrismaPosition): Position {
  return {
    id: row.id,
    agentId: row.agentId,
    amount: row.amount as TokenAmount,
    costBasisUSD: row.costBasisUSD,
    openedByTransactionId: row.openedByTransactionId,
    closedByTransactionId: row.closedByTransactionId ?? undefined,
    openedAt: numReq(row.openedAt),
    closedAt: num(row.closedAt),
    realizedPnlUSD: row.realizedPnlUSD,
  };
}

export function positionDomainToRow(p: Position): Omit<PrismaPosition, never> {
  return {
    id: p.id,
    agentId: p.agentId,
    amount: p.amount as PrismaPosition['amount'],
    costBasisUSD: p.costBasisUSD,
    openedByTransactionId: p.openedByTransactionId,
    closedByTransactionId: p.closedByTransactionId ?? null,
    openedAt: BigInt(p.openedAt),
    closedAt: p.closedAt === null ? null : BigInt(p.closedAt),
    realizedPnlUSD: p.realizedPnlUSD,
  };
}

export function memoryEntryRowToDomain(row: PrismaMemoryEntry): MemoryEntry {
  return {
    id: row.id,
    tickId: row.tickId,
    type: row.type as MemoryEntry['type'],
    content: row.content,
    parentEntryIds: row.parentEntryIds.length > 0 ? row.parentEntryIds : undefined,
    createdAt: numReq(row.createdAt),
  };
}

export function memoryRowToDomain(
  row: PrismaAgentMemory & { entries: PrismaMemoryEntry[] },
): AgentMemory {
  return {
    agentId: row.agentId,
    notes: row.notes,
    state: row.state as Record<string, unknown>,
    updatedAt: numReq(row.updatedAt),
    entries: row.entries.map(memoryEntryRowToDomain),
  };
}

export function activityEventRowToDomain(row: PrismaActivityEvent): AgentActivityLogEntry {
  return {
    agentId: row.agentId,
    tickId: row.tickId ?? '',
    timestamp: numReq(row.timestamp),
    type: row.type as AgentActivityLogEntry['type'],
    payload: row.payload as Record<string, unknown>,
    seq: numReq(row.seq),
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run db:generate && npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/database/prisma-database/mappers.ts
git commit -m "feat(db): add Prisma row ↔ domain mappers"
```

---

### Task 14: `PrismaAgentRepository` (TDD)

**Files:**
- Create: `src/database/prisma-database/prisma-agent-repository.ts`
- Test: `src/database/prisma-database/prisma-database.live.test.ts` (this test file grows across tasks 14–17; we add the agent suite first)

- [ ] **Step 1: Write the failing test**

```typescript
// src/database/prisma-database/prisma-database.live.test.ts
import { it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { describeIfPostgres, getTestPrisma, truncateAll } from './test-helpers';
import { PrismaAgentRepository } from './prisma-agent-repository';
import type { AgentConfig } from '../types';

describeIfPostgres('PrismaAgentRepository', () => {
  const prisma = getTestPrisma()!;
  const repo = new PrismaAgentRepository(prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  function makeAgent(id: string): AgentConfig {
    return {
      id,
      name: `agent-${id}`,
      prompt: 'do the thing',
      dryRun: true,
      dryRunSeedBalances: { native: '1000' },
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 },
      createdAt: Date.now(),
      running: true,
      intervalMs: 180_000,
      lastTickAt: null,
    };
  }

  it('upsert + findById round-trip', async () => {
    const a = makeAgent('agent-1');
    await repo.upsert(a);
    const got = await repo.findById('agent-1');
    expect(got).not.toBeNull();
    expect(got?.id).toBe('agent-1');
    expect(got?.dryRun).toBe(true);
    expect(got?.riskLimits.maxTradeUSD).toBe(100);
    expect(got?.dryRunSeedBalances).toEqual({ native: '1000' });
    console.log('agent.findById →', got);
  });

  it('list returns all agents', async () => {
    await repo.upsert(makeAgent('a'));
    await repo.upsert(makeAgent('b'));
    const all = await repo.list();
    expect(all).toHaveLength(2);
    console.log('agent.list →', all.map((a) => a.id));
  });

  it('upsert updates existing row', async () => {
    const a = makeAgent('agent-1');
    await repo.upsert(a);
    await repo.upsert({ ...a, name: 'renamed' });
    const got = await repo.findById('agent-1');
    expect(got?.name).toBe('renamed');
  });

  it('delete removes the row', async () => {
    await repo.upsert(makeAgent('agent-1'));
    await repo.delete('agent-1');
    expect(await repo.findById('agent-1')).toBeNull();
  });

  it('findById returns null for missing agent', async () => {
    expect(await repo.findById('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npm test -- prisma-database.live`

Before running: ensure `npm run db:up` was applied to the test DB. To apply migrations to the test DB:
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npx prisma migrate deploy
```

Expected: import error (PrismaAgentRepository doesn't exist).

- [ ] **Step 3: Implement `PrismaAgentRepository`**

```typescript
// src/database/prisma-database/prisma-agent-repository.ts
import type { PrismaClient } from '@prisma/client';
import type { AgentConfig } from '../types';
import type { AgentRepository } from '../repositories/agent-repository';
import { agentDomainToRow, agentRowToDomain } from './mappers';

export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AgentConfig[]> {
    const rows = await this.prisma.agent.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(agentRowToDomain);
  }

  async findById(id: string): Promise<AgentConfig | null> {
    const row = await this.prisma.agent.findUnique({ where: { id } });
    return row ? agentRowToDomain(row) : null;
  }

  async upsert(agent: AgentConfig): Promise<void> {
    const { create, update } = agentDomainToRow(agent);
    await this.prisma.agent.upsert({
      where: { id: agent.id },
      create,
      update,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.agent.delete({ where: { id } }).catch((err) => {
      // Swallow "record to delete does not exist" — matches FileAgentRepository semantics.
      if ((err as { code?: string }).code === 'P2025') return;
      throw err;
    });
  }
}
```

- [ ] **Step 4: Run tests, watch them pass**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npm test -- prisma-database.live`
Expected: all 5 tests pass; `console.log` shows the round-tripped agent shape.

- [ ] **Step 5: Commit**

```bash
git add src/database/prisma-database/prisma-agent-repository.ts \
        src/database/prisma-database/prisma-database.live.test.ts
git commit -m "feat(db): PrismaAgentRepository + live test"
```

---

### Task 15: `PrismaTransactionRepository` (TDD)

**Files:**
- Create: `src/database/prisma-database/prisma-transaction-repository.ts`
- Modify: `src/database/prisma-database/prisma-database.live.test.ts` (append a new `describeIfPostgres` block)

- [ ] **Step 1: Write the failing test (append to existing test file)**

```typescript
// append at end of src/database/prisma-database/prisma-database.live.test.ts
import { PrismaTransactionRepository } from './prisma-transaction-repository';
import type { Transaction, TokenAmount } from '../types';

describeIfPostgres('PrismaTransactionRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const txs = new PrismaTransactionRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    // FK constraint: tx requires existing agent
    await agents.upsert({
      id: 'a1',
      name: 'a1',
      prompt: '',
      dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 },
      createdAt: Date.now(),
    });
  });

  const usdc: TokenAmount = {
    tokenAddress: '0xUSDC',
    symbol: 'USDC',
    amountRaw: '1000000000',
    decimals: 6,
  };

  function makeTx(id: string, agentId = 'a1'): Transaction {
    return {
      id,
      agentId,
      hash: `0x${'0'.repeat(60)}${id.padStart(4, '0')}`,
      chainId: 130,
      from: '0xabc',
      to: '0xdef',
      tokenIn: usdc,
      tokenOut: undefined,
      gasUsed: '21000',
      gasPriceWei: '1000000000',
      gasCostWei: '21000000000000',
      status: 'success',
      blockNumber: 12345,
      timestamp: Date.now(),
    };
  }

  it('insert + findById', async () => {
    await txs.insert(makeTx('t1'));
    const got = await txs.findById('t1');
    expect(got?.id).toBe('t1');
    expect(got?.tokenIn?.symbol).toBe('USDC');
    expect(got?.gasUsed).toBe('21000');
    console.log('tx.findById →', got);
  });

  it('listByAgent with limit returns last N', async () => {
    for (let i = 1; i <= 5; i++) {
      await txs.insert({ ...makeTx(`t${i}`), timestamp: i });
    }
    const last3 = await txs.listByAgent('a1', { limit: 3 });
    expect(last3).toHaveLength(3);
    // listByAgent in file impl returned chronological order, last N — match that
    expect(last3.map((t) => t.id)).toEqual(['t3', 't4', 't5']);
  });

  it('updateStatus mutates only allowed fields', async () => {
    await txs.insert({ ...makeTx('t1'), status: 'pending', blockNumber: null, hash: '0xpending' });
    await txs.updateStatus('t1', { status: 'success', blockNumber: 999, hash: '0xfinal' });
    const got = await txs.findById('t1');
    expect(got?.status).toBe('success');
    expect(got?.blockNumber).toBe(999);
    expect(got?.hash).toBe('0xfinal');
  });
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `TEST_DATABASE_URL=... npm test -- prisma-database.live`
Expected: import error.

- [ ] **Step 3: Implement**

```typescript
// src/database/prisma-database/prisma-transaction-repository.ts
import type { PrismaClient } from '@prisma/client';
import type { Transaction } from '../types';
import type { TransactionRepository } from '../repositories/transaction-repository';
import { txDomainToCreate, txRowToDomain } from './mappers';

export class PrismaTransactionRepository implements TransactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(tx: Transaction): Promise<void> {
    await this.prisma.transaction.create({ data: txDomainToCreate(tx) });
  }

  async findById(id: string): Promise<Transaction | null> {
    const row = await this.prisma.transaction.findUnique({ where: { id } });
    return row ? txRowToDomain(row) : null;
  }

  async listByAgent(agentId: string, opts?: { limit?: number }): Promise<Transaction[]> {
    if (typeof opts?.limit === 'number') {
      const rows = await this.prisma.transaction.findMany({
        where: { agentId },
        orderBy: { timestamp: 'desc' },
        take: opts.limit,
      });
      // Reverse to match FileTransactionRepository chronological-ascending shape
      return rows.reverse().map(txRowToDomain);
    }
    const rows = await this.prisma.transaction.findMany({
      where: { agentId },
      orderBy: { timestamp: 'asc' },
    });
    return rows.map(txRowToDomain);
  }

  async updateStatus(
    id: string,
    patch: Pick<Transaction, 'status' | 'blockNumber' | 'hash'>,
  ): Promise<void> {
    await this.prisma.transaction.update({
      where: { id },
      data: {
        status: patch.status,
        blockNumber: patch.blockNumber === null ? null : BigInt(patch.blockNumber),
        hash: patch.hash,
      },
    });
  }
}
```

- [ ] **Step 4: Run tests, watch them pass**

Run: `TEST_DATABASE_URL=... npm test -- prisma-database.live`
Expected: 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/database/prisma-database/prisma-transaction-repository.ts \
        src/database/prisma-database/prisma-database.live.test.ts
git commit -m "feat(db): PrismaTransactionRepository + live test"
```

---

### Task 16: `PrismaPositionRepository` (TDD)

**Files:**
- Create: `src/database/prisma-database/prisma-position-repository.ts`
- Modify: `src/database/prisma-database/prisma-database.live.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

```typescript
import { PrismaPositionRepository } from './prisma-position-repository';
import type { Position } from '../types';

describeIfPostgres('PrismaPositionRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const positions = new PrismaPositionRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    await agents.upsert({
      id: 'a1', name: 'a1', prompt: '', dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
    });
  });

  function makePos(id: string, opts: { closed?: boolean; tokenAddress?: string } = {}): Position {
    return {
      id,
      agentId: 'a1',
      amount: {
        tokenAddress: opts.tokenAddress ?? '0xUNI',
        symbol: 'UNI',
        amountRaw: '500000000000000000',
        decimals: 18,
      },
      costBasisUSD: 5,
      openedByTransactionId: 'tx-open',
      closedByTransactionId: opts.closed ? 'tx-close' : undefined,
      openedAt: Date.now(),
      closedAt: opts.closed ? Date.now() : null,
      realizedPnlUSD: opts.closed ? 1.5 : null,
    };
  }

  it('insert + listByAgent', async () => {
    await positions.insert(makePos('p1'));
    await positions.insert(makePos('p2', { closed: true }));
    const all = await positions.listByAgent('a1');
    expect(all).toHaveLength(2);
    console.log('positions.listByAgent →', all.map((p) => ({ id: p.id, closed: p.closedAt !== null })));
  });

  it('findOpen returns the open position for the token', async () => {
    await positions.insert(makePos('p1'));
    await positions.insert(makePos('p2', { closed: true, tokenAddress: '0xOTHER' }));
    const open = await positions.findOpen('a1', '0xUNI');
    expect(open?.id).toBe('p1');
  });

  it('findOpen returns null when only closed positions exist', async () => {
    await positions.insert(makePos('p1', { closed: true }));
    const open = await positions.findOpen('a1', '0xUNI');
    expect(open).toBeNull();
  });

  it('update mutates the row', async () => {
    await positions.insert(makePos('p1'));
    const updated = makePos('p1', { closed: true });
    await positions.update(updated);
    const got = (await positions.listByAgent('a1'))[0];
    expect(got?.closedAt).not.toBeNull();
    expect(got?.realizedPnlUSD).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run, watch it fail**

Run: `TEST_DATABASE_URL=... npm test -- prisma-database.live`

- [ ] **Step 3: Implement**

```typescript
// src/database/prisma-database/prisma-position-repository.ts
import type { PrismaClient } from '@prisma/client';
import type { Position } from '../types';
import type { PositionRepository } from '../repositories/position-repository';
import { positionDomainToRow, positionRowToDomain } from './mappers';

export class PrismaPositionRepository implements PositionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(pos: Position): Promise<void> {
    await this.prisma.position.create({ data: positionDomainToRow(pos) });
  }

  async findOpen(agentId: string, tokenAddress: string): Promise<Position | null> {
    // Filter on JSONB amount.tokenAddress — Postgres has good support for this via Prisma.
    const rows = await this.prisma.position.findMany({
      where: {
        agentId,
        closedAt: null,
        amount: { path: ['tokenAddress'], equals: tokenAddress },
      },
    });
    return rows[0] ? positionRowToDomain(rows[0]) : null;
  }

  async listByAgent(agentId: string): Promise<Position[]> {
    const rows = await this.prisma.position.findMany({
      where: { agentId },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map(positionRowToDomain);
  }

  async update(pos: Position): Promise<void> {
    await this.prisma.position.update({
      where: { id: pos.id },
      data: positionDomainToRow(pos),
    });
  }
}
```

- [ ] **Step 4: Run tests, watch pass**

Run: `TEST_DATABASE_URL=... npm test -- prisma-database.live`
Expected: all position tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/database/prisma-database/prisma-position-repository.ts \
        src/database/prisma-database/prisma-database.live.test.ts
git commit -m "feat(db): PrismaPositionRepository + live test"
```

---

### Task 17: `PrismaAgentMemoryRepository` (TDD)

**Files:**
- Create: `src/database/prisma-database/prisma-agent-memory-repository.ts`
- Modify: `src/database/prisma-database/prisma-database.live.test.ts` (append)

- [ ] **Step 1: Failing test (append)**

```typescript
import { PrismaAgentMemoryRepository } from './prisma-agent-memory-repository';
import type { AgentMemory } from '../types';

describeIfPostgres('PrismaAgentMemoryRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const memory = new PrismaAgentMemoryRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    await agents.upsert({
      id: 'a1', name: 'a1', prompt: '', dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
    });
  });

  function makeMemory(): AgentMemory {
    return {
      agentId: 'a1',
      notes: 'hello',
      state: { lastPriceUSD: 5.5, mode: 'observe' },
      updatedAt: Date.now(),
      entries: [
        { id: 'e1', tickId: 't1', type: 'observation', content: 'noted price', createdAt: Date.now() },
        { id: 'e2', tickId: 't2', type: 'snapshot', content: 'snap', parentEntryIds: ['e1'], createdAt: Date.now() + 1 },
      ],
    };
  }

  it('upsert + get round-trip with entries', async () => {
    await memory.upsert(makeMemory());
    const got = await memory.get('a1');
    expect(got?.notes).toBe('hello');
    expect(got?.state).toEqual({ lastPriceUSD: 5.5, mode: 'observe' });
    expect(got?.entries).toHaveLength(2);
    expect(got?.entries[1]?.parentEntryIds).toEqual(['e1']);
    console.log('memory.get →', got);
  });

  it('upsert overwrites entries (full replace semantics matches file impl)', async () => {
    const m = makeMemory();
    await memory.upsert(m);
    await memory.upsert({ ...m, entries: [{ id: 'e3', tickId: 't3', type: 'note', content: 'new', createdAt: Date.now() }] });
    const got = await memory.get('a1');
    expect(got?.entries).toHaveLength(1);
    expect(got?.entries[0]?.id).toBe('e3');
  });

  it('get returns null for unknown agent', async () => {
    expect(await memory.get('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, watch it fail**

- [ ] **Step 3: Implement**

```typescript
// src/database/prisma-database/prisma-agent-memory-repository.ts
import type { PrismaClient } from '@prisma/client';
import type { AgentMemory } from '../types';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import { memoryRowToDomain } from './mappers';

export class PrismaAgentMemoryRepository implements AgentMemoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(agentId: string): Promise<AgentMemory | null> {
    const row = await this.prisma.agentMemory.findUnique({
      where: { agentId },
      include: { entries: { orderBy: { createdAt: 'asc' } } },
    });
    return row ? memoryRowToDomain(row) : null;
  }

  async upsert(memory: AgentMemory): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.agentMemory.upsert({
        where: { agentId: memory.agentId },
        create: {
          agentId: memory.agentId,
          notes: memory.notes,
          state: memory.state as object,
          updatedAt: BigInt(memory.updatedAt),
        },
        update: {
          notes: memory.notes,
          state: memory.state as object,
          updatedAt: BigInt(memory.updatedAt),
        },
      });

      // Full-replace entries to match FileAgentMemoryRepository semantics.
      await tx.memoryEntry.deleteMany({ where: { agentId: memory.agentId } });
      if (memory.entries.length > 0) {
        await tx.memoryEntry.createMany({
          data: memory.entries.map((e) => ({
            id: e.id,
            agentId: memory.agentId,
            tickId: e.tickId,
            type: e.type,
            content: e.content,
            parentEntryIds: e.parentEntryIds ?? [],
            createdAt: BigInt(e.createdAt),
          })),
        });
      }
    });
  }
}
```

- [ ] **Step 4: Run tests, watch pass**

Run: `TEST_DATABASE_URL=... npm test -- prisma-database.live`

- [ ] **Step 5: Commit**

```bash
git add src/database/prisma-database/prisma-agent-memory-repository.ts \
        src/database/prisma-database/prisma-database.live.test.ts
git commit -m "feat(db): PrismaAgentMemoryRepository + live test"
```

---

### Task 18: `PrismaActivityLogRepository` (TDD)

**Files:**
- Create: `src/database/prisma-database/prisma-activity-log-repository.ts`
- Create: `src/database/prisma-database/prisma-activity-log-repository.live.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/database/prisma-database/prisma-activity-log-repository.live.test.ts
import { it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { describeIfPostgres, getTestPrisma, truncateAll } from './test-helpers';
import { PrismaAgentRepository } from './prisma-agent-repository';
import { PrismaActivityLogRepository } from './prisma-activity-log-repository';

describeIfPostgres('PrismaActivityLogRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const log = new PrismaActivityLogRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    await agents.upsert({
      id: 'a1', name: 'a1', prompt: '', dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
    });
  });

  it('append assigns monotonically increasing seq', async () => {
    const e1 = await log.append({ agentId: 'a1', tickId: 't1', timestamp: 1, type: 'tick_start', payload: {} });
    const e2 = await log.append({ agentId: 'a1', tickId: 't1', timestamp: 2, type: 'tick_end', payload: {} });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    console.log('append seqs →', { s1: e1.seq, s2: e2.seq });
  });

  it('listByAgent returns entries ordered by seq ascending', async () => {
    for (let i = 0; i < 5; i++) {
      await log.append({ agentId: 'a1', tickId: `t${i}`, timestamp: i, type: 'tick_start', payload: { i } });
    }
    const all = await log.listByAgent('a1');
    expect(all).toHaveLength(5);
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq);
    }
  });

  it('listByAgent with limit returns last N', async () => {
    for (let i = 0; i < 10; i++) {
      await log.append({ agentId: 'a1', tickId: `t${i}`, timestamp: i, type: 'tick_start', payload: { i } });
    }
    const tail = await log.listByAgent('a1', { limit: 3 });
    expect(tail).toHaveLength(3);
    expect(tail.map((e) => e.payload.i)).toEqual([7, 8, 9]);
  });

  it('listByAgent with sinceTickId returns entries after the LAST entry of the anchor tick', async () => {
    // Tick t1: 3 entries; Tick t2: 2 entries
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 1, type: 'tick_start', payload: {} });
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 2, type: 'llm_call', payload: { model: 'x', promptChars: 0 } });
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 3, type: 'tick_end', payload: {} });
    await log.append({ agentId: 'a1', tickId: 't2', timestamp: 4, type: 'tick_start', payload: {} });
    await log.append({ agentId: 'a1', tickId: 't2', timestamp: 5, type: 'tick_end', payload: {} });

    const after = await log.listByAgent('a1', { sinceTickId: 't1' });
    expect(after).toHaveLength(2);
    expect(after.every((e) => e.tickId === 't2')).toBe(true);
  });

  it('listByAgent with sinceTickId returns all when anchor not found', async () => {
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 1, type: 'tick_start', payload: {} });
    const all = await log.listByAgent('a1', { sinceTickId: 'never-existed' });
    expect(all).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, watch it fail**

- [ ] **Step 3: Implement**

```typescript
// src/database/prisma-database/prisma-activity-log-repository.ts
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import type { AgentActivityLogEntry, AgentActivityLogEntryInput } from '../types';
import { activityEventRowToDomain } from './mappers';

export class PrismaActivityLogRepository implements ActivityLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: AgentActivityLogEntryInput): Promise<AgentActivityLogEntry> {
    const row = await this.prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        agentId: entry.agentId,
        tickId: entry.tickId,
        type: entry.type,
        level: 'info',
        payload: entry.payload as object,
        timestamp: BigInt(entry.timestamp),
      },
    });
    return activityEventRowToDomain(row);
  }

  async listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]> {
    let entries: AgentActivityLogEntry[];

    if (opts?.sinceTickId) {
      // Find the largest seq for the anchor tickId (the LAST entry of that tick).
      const anchor = await this.prisma.activityEvent.findFirst({
        where: { agentId, tickId: opts.sinceTickId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      if (anchor === null) {
        // Anchor not found → return all (matches FileActivityLogRepository semantics).
        const rows = await this.prisma.activityEvent.findMany({
          where: { agentId },
          orderBy: { seq: 'asc' },
        });
        entries = rows.map(activityEventRowToDomain);
      } else {
        const rows = await this.prisma.activityEvent.findMany({
          where: { agentId, seq: { gt: anchor.seq } },
          orderBy: { seq: 'asc' },
        });
        entries = rows.map(activityEventRowToDomain);
      }
    } else {
      const rows = await this.prisma.activityEvent.findMany({
        where: { agentId },
        orderBy: { seq: 'asc' },
      });
      entries = rows.map(activityEventRowToDomain);
    }

    if (typeof opts?.limit === 'number') {
      entries = entries.slice(-opts.limit);
    }
    return entries;
  }
}
```

- [ ] **Step 4: Run tests, watch pass**

Run: `TEST_DATABASE_URL=... npm test -- prisma-activity-log-repository.live`

- [ ] **Step 5: Commit**

```bash
git add src/database/prisma-database/prisma-activity-log-repository.ts \
        src/database/prisma-database/prisma-activity-log-repository.live.test.ts
git commit -m "feat(db): PrismaActivityLogRepository + live test"
```

---

### Task 19: `PrismaDatabase` composer

**Files:**
- Create: `src/database/prisma-database/prisma-database.ts`

- [ ] **Step 1: Write the composer**

```typescript
// src/database/prisma-database/prisma-database.ts
import type { PrismaClient } from '@prisma/client';
import type { Database } from '../database';
import type { AgentRepository } from '../repositories/agent-repository';
import type { TransactionRepository } from '../repositories/transaction-repository';
import type { PositionRepository } from '../repositories/position-repository';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import { PrismaAgentRepository } from './prisma-agent-repository';
import { PrismaTransactionRepository } from './prisma-transaction-repository';
import { PrismaPositionRepository } from './prisma-position-repository';
import { PrismaAgentMemoryRepository } from './prisma-agent-memory-repository';
import { PrismaActivityLogRepository } from './prisma-activity-log-repository';

export class PrismaDatabase implements Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.agents = new PrismaAgentRepository(prisma);
    this.transactions = new PrismaTransactionRepository(prisma);
    this.positions = new PrismaPositionRepository(prisma);
    this.agentMemory = new PrismaAgentMemoryRepository(prisma);
    this.activityLog = new PrismaActivityLogRepository(prisma);
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/database/prisma-database/prisma-database.ts
git commit -m "feat(db): PrismaDatabase composer (5 repos behind one facade)"
```

---

## Phase D — Cutover

### Task 20: Switch `src/index.ts` from FileDatabase to PrismaDatabase

**Files:**
- Modify: [src/index.ts](../../../src/index.ts)

- [ ] **Step 1: Replace database construction**

In `src/index.ts`:

```typescript
// remove these imports:
//   import { FileDatabase } from './database/file-database/file-database';

// add:
import { PrismaClient } from '@prisma/client';
import { PrismaDatabase } from './database/prisma-database/prisma-database';

// in main():
const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const db = new PrismaDatabase(prisma);
const activityLog = new AgentActivityLog(db.activityLog);
```

Update the shutdown handler to disconnect Prisma:

```typescript
const shutdown = async (signal: string) => {
  console.log(`[bootstrap] received ${signal}, stopping`);
  if (looper) looper.stop();
  if (api) await api.stop().catch(() => {});
  await db.disconnect().catch(() => {});
  process.exit(0);
};
```

- [ ] **Step 2: Smoke test**

```bash
npm run db:up
npm run db:migrate
npm start
```

Expected: bootstrap log lines print; looper ticks (no agents loaded yet); Ctrl-C cleanly disconnects.

Verify by querying directly:
```bash
docker compose exec postgres psql -U postgres -d agent_loop -c 'SELECT count(*) FROM "Agent";'
```
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(db): switch bootstrap to PrismaDatabase"
```

---

### Task 21: Delete the entire `src/database/file-database/` directory

**Files:**
- Delete: `src/database/file-database/` (entire directory)

- [ ] **Step 1: Confirm no consumers remain**

Run: `grep -rn "file-database" src/ scripts/ --include="*.ts"`
Expected: no matches (only the directory itself contains the name).

- [ ] **Step 2: Delete**

```bash
git rm -r src/database/file-database/
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: passes; live tests for Prisma still run when `TEST_DATABASE_URL` is set.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(db): delete FileDatabase implementation"
```

---

## Phase E — Seed + cleanup

### Task 22: Create `prisma/seed.ts`

**Files:**
- Create: [prisma/seed.ts](../../../prisma/seed.ts)

- [ ] **Step 1: Write the seed script**

```typescript
// prisma/seed.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { confirmContinue } from '../src/test-lib/interactive-prompt';
import { buildSeedAgentConfig, SEED_AGENT_ID } from '../scripts/lib/seed-uni-ma-trader';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const repo = new PrismaAgentRepository(prisma);
    const existing = await repo.findById(SEED_AGENT_ID);
    if (existing) {
      console.error(`[seed] agent id "${SEED_AGENT_ID}" already exists in DB.`);
      console.error(`[seed] v1 supports only a single seed agent. Run \`npm run db:reset\` to start fresh.`);
      process.exit(1);
    }

    const realMode = process.argv.includes('--real');
    const dryRun = !realMode;

    const modeLabel = dryRun
      ? 'DRY-RUN (synthetic swaps, simulated balances, no real funds)'
      : 'REAL ONCHAIN (every swap signs + broadcasts a real tx; agent will spend gas + tokens from your wallet)';

    const ok = await confirmContinue(
      `Install UNI MA trader seed agent into Postgres? Mode: ${modeLabel}`,
    );
    if (!ok) {
      console.log('[seed] cancelled.');
      return;
    }

    const seed = buildSeedAgentConfig({ dryRun });
    await repo.upsert(seed);

    console.log(`[seed] installed agent "${seed.id}" (dryRun=${dryRun}).`);
    if (!dryRun) {
      console.log(`[seed] WARNING: real-onchain mode. Make sure the wallet has UNI/USDC + gas before running \`npm start\`.`);
    }
    console.log(`[seed] next: \`npm start\` to run the loop.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke test**

```bash
npm run db:reset       # wipes DB, re-runs migrations, runs seed automatically (because of prisma.seed config)
```

Expected: prompt appears asking to install seed agent; answer `y`; agent inserted. Then:

```bash
docker compose exec postgres psql -U postgres -d agent_loop -c 'SELECT id, name, "dryRun" FROM "Agent";'
```
Expected: one row with `id = uni-ma-trader-v1`, `dryRun = t`.

- [ ] **Step 3: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat(db): add prisma/seed.ts (replaces scripts/seed-agent.ts)"
```

---

### Task 23: Delete obsolete scripts

**Files:**
- Delete: `scripts/seed-agent.ts`
- Delete: `scripts/reset-db.ts`

- [ ] **Step 1: Confirm npm scripts no longer reference them**

Run: `grep -n "seed-agent\|reset-db" package.json`
Expected: no matches (Task 10 already removed both `seed-agent` and `reset-db` script entries).

- [ ] **Step 2: Delete**

```bash
git rm scripts/seed-agent.ts scripts/reset-db.ts
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(scripts): delete legacy seed-agent.ts and reset-db.ts"
```

---

### Task 24: Update CLAUDE.md

**Files:**
- Modify: [CLAUDE.md](../../../CLAUDE.md)

- [ ] **Step 1: Update the storage section**

Find the section describing `database/` vs `agent-activity-log/` separation (around the "Database = storage-agnostic facade" header and the "Separation" line). Replace with:

```markdown
### Database = storage-agnostic facade, Prisma + Postgres

`Database` is a composition of repositories (`AgentRepository`, `TransactionRepository`, `PositionRepository`, `AgentMemoryRepository`, `ActivityLogRepository`) — no SQL, paths, or storage primitives leak through the interface. Domain types carry no storage-specific fields.

v1 backend = `PrismaDatabase` against Postgres 16 (Docker locally; Supabase in production). Activity log lives in the same DB as structured state — the file-shaped justification for keeping it in its own module disappeared once both stores became SQL.

Local dev:
- `npm run db:up` / `db:down` / `db:nuke` — Docker Compose lifecycle
- `npm run db:migrate` — apply Prisma migrations
- `npm run db:seed` — install the seed UNI MA trader agent
- `npm run db:reset` — wipe data, re-migrate, re-seed
- `npm run db:studio` — open Prisma Studio

`zerog-bootstrap.json` (0G provider state) stays in `db/` as a file — it is a singleton paid asset that gets its own migration cycle in a future spec.

Schema in `prisma/schema.prisma`. Tests against a separate `agent_loop_test` database controlled by `TEST_DATABASE_URL`; live tests skip when the env var is missing so `npm test` is always safe to run.
```

Also update the file-tree block in CLAUDE.md to reflect the consolidated module structure (remove `agent-activity-log/`, mention `prisma-database/` under `database/`).

- [ ] **Step 2: Update env section**

In CLAUDE.md's `## Env` block, add:

```
# Postgres
DATABASE_URL=
TEST_DATABASE_URL=        # optional; live tests skip when absent
```

- [ ] **Step 3: Verify**

Re-read the changed sections to confirm internal consistency.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): update storage section for Postgres + consolidated activity log"
```

---

## End-to-end verification

After Task 24, run the full happy-path:

```bash
npm run db:nuke
npm run db:up
npm run db:migrate
npm run db:seed         # answer y
npm start               # let it tick once, Ctrl-C
docker compose exec postgres psql -U postgres -d agent_loop -c '
  SELECT count(*) AS agents     FROM "Agent";
  SELECT count(*) AS events     FROM "ActivityEvent";
  SELECT count(*) AS memory     FROM "AgentMemory";
'
```

Expected:
- `agents = 1` (the seed agent)
- `events ≥ 1` (looper logged at least one tick to activity log)
- `memory = 0` or `1` depending on whether the agent's first tick wrote memory

If `events = 0`, the wiring in Task 5 + 20 didn't connect properly — investigate `AgentActivityLog` construction in `src/index.ts`.

---

## Task summary

| # | Phase | Task | Touches |
|---|-------|------|---------|
| 0 | 0 | Remove dead `AgentConfig.walletAddress` | domain + fixtures |
| 1 | A | Move activity-log types into `database/types.ts` | types only |
| 2 | A | Rename `ActivityLogStore` → `ActivityLogRepository` | interface |
| 3 | A | Move `AgentActivityLog` facade under `database/` | facade |
| 4 | A | Move `FileActivityLogStore` → `FileActivityLogRepository` | file impl + test |
| 5 | A | Add `activityLog` to `Database`, expose from `FileDatabase`, rewire imports | wiring |
| 6 | A | Delete `src/agent-activity-log/` | cleanup |
| 7 | B | Docker Compose + test-DB init | infra |
| 8 | B | Add `DATABASE_URL` / `TEST_DATABASE_URL` to env | config |
| 9 | B | Install Prisma + write `schema.prisma` | infra |
| 10 | B | Add `db:*` npm scripts | infra |
| 11 | B | Run first migration | infra |
| 12 | C | Test helpers (truncate/skip) | tests |
| 13 | C | `mappers.ts` | mappers |
| 14 | C | `PrismaAgentRepository` (TDD) | repo + test |
| 15 | C | `PrismaTransactionRepository` (TDD) | repo + test |
| 16 | C | `PrismaPositionRepository` (TDD) | repo + test |
| 17 | C | `PrismaAgentMemoryRepository` (TDD) | repo + test |
| 18 | C | `PrismaActivityLogRepository` (TDD) | repo + test |
| 19 | C | `PrismaDatabase` composer | composer |
| 20 | D | Switch `src/index.ts` to `PrismaDatabase` | wiring |
| 21 | D | Delete `src/database/file-database/` | cleanup |
| 22 | E | `prisma/seed.ts` | seed |
| 23 | E | Delete `scripts/seed-agent.ts` + `scripts/reset-db.ts` | cleanup |
| 24 | E | Update CLAUDE.md | docs |
