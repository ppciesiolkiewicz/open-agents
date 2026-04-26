# Slice 2 — Database + Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `database/` module (storage-agnostic facade with 4 repositories) backed by a `FileDatabase` impl, plus the `agent-activity-log/` module backed by a `FileActivityLogStore`. Wire both into `src/index.ts` so `npm start` initializes them. End state: agents/transactions/positions/memory persist across restarts; activity log files appear under `./db/activity-log/`.

**Architecture:** Domain types + interfaces in `database/`; file-backed implementations in `database/file-database/`. Activity log is a separate module (`agent-activity-log/`) with its own `ActivityLogStore` abstraction. Single global `Database` instance shared by all consumers, agentId-keyed entities, no foreign-key cascades. Plain `fs.writeFile`/`appendFile` (no atomic rename — we'll move to a real DB before torn-write risk matters). No `delete()` on `AgentRepository` for v1 (operators clear DB by hand).

**Tech Stack:** TypeScript 5.x, Node 20+, vitest (live tests against real filesystem). Native `node:fs/promises`. No new npm deps.

**Spec reference:** [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](../specs/2026-04-26-agent-loop-foundation-design.md) — sections "DB", "Schema", "Wallet" (DryRunWallet ledger), "AI Integration (0G)" (zerog-bootstrap.json layout note).

**Test rule (slice 2):**
- `database/file-database/` and `agent-activity-log/file-activity-log-store.ts` get `*.live.test.ts` (filesystem = integration, hits real disk under a tmpdir)
- Pure types and interfaces get no tests
- DryRunWallet hash util gets a small `*.live.test.ts` (uniqueness sanity check)

---

## File Structure

```
src/
  database/
    types.ts                              # AgentConfig, Transaction, Position, AgentMemory, TokenAmount
    database.ts                           # Database interface (composes 4 repos)
    repositories/
      agent-repository.ts                 # AgentRepository interface
      transaction-repository.ts           # TransactionRepository interface
      position-repository.ts              # PositionRepository interface
      agent-memory-repository.ts          # AgentMemoryRepository interface
    file-database/
      file-database.ts                    # FileDatabase class (composes 4 file-backed repos)
      file-agent-repository.ts            # FileAgentRepository (slice of database.json)
      file-transaction-repository.ts      # FileTransactionRepository
      file-position-repository.ts         # FilePositionRepository
      file-agent-memory-repository.ts     # FileAgentMemoryRepository (per-agent file)
      file-database.live.test.ts          # round-trip every entity type
  agent-activity-log/
    types.ts                              # AgentActivityLogEntry, log type union
    activity-log-store.ts                 # ActivityLogStore interface
    file-activity-log-store.ts            # FileActivityLogStore class
    agent-activity-log.ts                 # AgentActivityLog (typed append helpers)
    file-activity-log-store.live.test.ts  # append + read round-trip
  wallet/
    dry-run/
      dry-run-hash.ts                     # generateDryRunHash() (producer only)
      dry-run-hash.live.test.ts           # uniqueness sanity check
  index.ts                                # MODIFY — instantiate FileDatabase + activity log
```

Notes on the split:
- `database/types.ts` holds all entity types in one place (TokenAmount is shared across Transaction + Position; keeping them adjacent prevents circular imports).
- `database/repositories/*.ts` — one interface per file. Tiny files but clear boundary; future SQLite/Postgres backends drop in alongside `file-database/`.
- `database/file-database/*.ts` — one class per file. `FileDatabase` is the composition root.
- All files stay <120 LOC.

---

## Task 1: Domain types

**Files:**
- Create: `src/database/types.ts`

No test (pure types, no runtime behavior).

- [ ] **Step 1: Create `src/database/types.ts`**

```ts
export interface TokenAmount {
  tokenAddress: string;
  symbol: string;
  amountRaw: string;            // bigint as string
  decimals: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  prompt: string;
  walletAddress: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>;  // tokenAddr (or "native") → raw bigint string
  riskLimits: { maxTradeUSD: number; [k: string]: unknown };
  lastTickAt: number | null;
  createdAt: number;
}

export interface Transaction {
  id: string;
  agentId: string;
  hash: string;                 // real 0x-prefixed hash, or dry-run sentinel
  chainId: number;
  from: string;
  to: string;
  tokenIn?: TokenAmount;
  tokenOut?: TokenAmount;
  gasUsed: string;              // bigint as string; estimated for dry-run
  gasPriceWei: string;          // bigint as string
  gasCostWei: string;           // bigint as string; gasUsed * gasPriceWei
  status: 'pending' | 'success' | 'failed';
  blockNumber: number | null;   // null for dry-run
  timestamp: number;
}

export interface Position {
  id: string;
  agentId: string;
  amount: TokenAmount;
  costBasisUSD: number;
  openedByTransactionId: string;
  closedByTransactionId?: string;
  openedAt: number;
  closedAt: number | null;
  realizedPnlUSD: number | null;
}

export interface AgentMemory {
  agentId: string;
  notes: string;
  state: Record<string, unknown>;
  updatedAt: number;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/database/types.ts
git commit -m "feat(database): add domain types (AgentConfig, Transaction, Position, AgentMemory, TokenAmount)"
```

---

## Task 2: Repository interfaces

**Files:**
- Create: `src/database/repositories/agent-repository.ts`
- Create: `src/database/repositories/transaction-repository.ts`
- Create: `src/database/repositories/position-repository.ts`
- Create: `src/database/repositories/agent-memory-repository.ts`

No tests (interfaces only).

- [ ] **Step 1: Create `src/database/repositories/agent-repository.ts`**

```ts
import type { AgentConfig } from '../types';

export interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  findById(id: string): Promise<AgentConfig | null>;
  upsert(agent: AgentConfig): Promise<void>;
}
```

- [ ] **Step 2: Create `src/database/repositories/transaction-repository.ts`**

```ts
import type { Transaction } from '../types';

export interface TransactionRepository {
  insert(tx: Transaction): Promise<void>;
  findById(id: string): Promise<Transaction | null>;
  listByAgent(agentId: string, opts?: { limit?: number }): Promise<Transaction[]>;
  updateStatus(
    id: string,
    patch: Pick<Transaction, 'status' | 'blockNumber' | 'hash'>,
  ): Promise<void>;
}
```

- [ ] **Step 3: Create `src/database/repositories/position-repository.ts`**

```ts
import type { Position } from '../types';

export interface PositionRepository {
  insert(pos: Position): Promise<void>;
  findOpen(agentId: string, tokenAddress: string): Promise<Position | null>;
  listByAgent(agentId: string): Promise<Position[]>;
  update(pos: Position): Promise<void>;
}
```

- [ ] **Step 4: Create `src/database/repositories/agent-memory-repository.ts`**

```ts
import type { AgentMemory } from '../types';

export interface AgentMemoryRepository {
  get(agentId: string): Promise<AgentMemory | null>;
  upsert(memory: AgentMemory): Promise<void>;
}
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/database/repositories/
git commit -m "feat(database): add repository interfaces (Agent, Transaction, Position, AgentMemory)"
```

---

## Task 3: Database facade interface

**Files:**
- Create: `src/database/database.ts`

- [ ] **Step 1: Create `src/database/database.ts`**

```ts
import type { AgentRepository } from './repositories/agent-repository';
import type { TransactionRepository } from './repositories/transaction-repository';
import type { PositionRepository } from './repositories/position-repository';
import type { AgentMemoryRepository } from './repositories/agent-memory-repository';

export interface Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/database/database.ts
git commit -m "feat(database): add Database facade interface composing 4 repositories"
```

---

## Task 4: Dry-run hash producer

**Files:**
- Create: `src/wallet/dry-run/dry-run-hash.ts`
- Create: `src/wallet/dry-run/dry-run-hash.live.test.ts`

The util belongs in `wallet/dry-run/` because `DryRunWallet` is the only producer. Database code never imports it.

- [ ] **Step 1: Write the failing test**

`src/wallet/dry-run/dry-run-hash.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateDryRunHash, DRY_RUN_HASH_REGEX } from './dry-run-hash';

describe('generateDryRunHash', () => {
  it('produces a 0x-prefixed 32-byte hex string', () => {
    const h = generateDryRunHash();
    console.log('[dry-run-hash] sample:', h);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.length).toBe(66);
  });

  it('matches the documented sentinel pattern (60 leading zeros + 4 hex)', () => {
    const h = generateDryRunHash();
    expect(h).toMatch(DRY_RUN_HASH_REGEX);
    expect(DRY_RUN_HASH_REGEX.source).toBe('^0x0{60}[0-9a-f]{4}$');
  });

  it('produces unique hashes across rapid calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateDryRunHash());
    expect(seen.size).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wallet/dry-run/`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `dry-run-hash.ts`**

```ts
export const DRY_RUN_HASH_REGEX = /^0x0{60}[0-9a-f]{4}$/;

let counter = 0;

export function generateDryRunHash(): string {
  counter = (counter + 1) & 0xffff;       // wrap at 65535, fits in 4 hex
  const suffix = counter.toString(16).padStart(4, '0');
  return `0x${'0'.repeat(60)}${suffix}`;
}
```

Note: counter wraps at 65 535. For v1 single-process use this is fine — collision would require a single agent to make >65k dry-run swaps in one DB session, which won't happen. If it ever does, swap to a hash of `Date.now() ^ counter`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/wallet/dry-run/`
Expected: PASS — 3 tests pass; sample hash logged.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/dry-run/
git commit -m "feat(wallet): add generateDryRunHash sentinel producer"
```

---

## Task 5: FileAgentRepository

**Files:**
- Create: `src/database/file-database/file-agent-repository.ts`

No standalone test — round-trip exercised by `file-database.live.test.ts` in Task 9.

- [ ] **Step 1: Implement `file-agent-repository.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentConfig } from '../types';
import type { AgentRepository } from '../repositories/agent-repository';

interface DatabaseFile {
  agents: AgentConfig[];
  transactions: unknown[];   // owned by FileTransactionRepository
  positions: unknown[];      // owned by FilePositionRepository
}

export class FileAgentRepository implements AgentRepository {
  constructor(private readonly dbDir: string) {}

  async list(): Promise<AgentConfig[]> {
    const file = await this.readFile();
    return file.agents;
  }

  async findById(id: string): Promise<AgentConfig | null> {
    const file = await this.readFile();
    return file.agents.find((a) => a.id === id) ?? null;
  }

  async upsert(agent: AgentConfig): Promise<void> {
    const file = await this.readFile();
    const idx = file.agents.findIndex((a) => a.id === agent.id);
    if (idx >= 0) file.agents[idx] = agent;
    else file.agents.push(agent);
    await this.writeFile(file);
  }

  private get path(): string {
    return join(this.dbDir, 'database.json');
  }

  private async readFile(): Promise<DatabaseFile> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as DatabaseFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { agents: [], transactions: [], positions: [] };
      }
      throw err;
    }
  }

  private async writeFile(file: DatabaseFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), 'utf8');
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/database/file-database/file-agent-repository.ts
git commit -m "feat(database): add FileAgentRepository (slice of database.json)"
```

---

## Task 6: FileTransactionRepository

**Files:**
- Create: `src/database/file-database/file-transaction-repository.ts`

- [ ] **Step 1: Implement `file-transaction-repository.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Transaction } from '../types';
import type { TransactionRepository } from '../repositories/transaction-repository';

interface DatabaseFile {
  agents: unknown[];
  transactions: Transaction[];
  positions: unknown[];
}

export class FileTransactionRepository implements TransactionRepository {
  constructor(private readonly dbDir: string) {}

  async insert(tx: Transaction): Promise<void> {
    const file = await this.readFile();
    file.transactions.push(tx);
    await this.writeFile(file);
  }

  async findById(id: string): Promise<Transaction | null> {
    const file = await this.readFile();
    return file.transactions.find((t) => t.id === id) ?? null;
  }

  async listByAgent(agentId: string, opts?: { limit?: number }): Promise<Transaction[]> {
    const file = await this.readFile();
    const all = file.transactions.filter((t) => t.agentId === agentId);
    return typeof opts?.limit === 'number' ? all.slice(-opts.limit) : all;
  }

  async updateStatus(
    id: string,
    patch: Pick<Transaction, 'status' | 'blockNumber' | 'hash'>,
  ): Promise<void> {
    const file = await this.readFile();
    const idx = file.transactions.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`Transaction ${id} not found`);
    const existing = file.transactions[idx]!;
    file.transactions[idx] = { ...existing, ...patch };
    await this.writeFile(file);
  }

  private get path(): string {
    return join(this.dbDir, 'database.json');
  }

  private async readFile(): Promise<DatabaseFile> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as DatabaseFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { agents: [], transactions: [], positions: [] };
      }
      throw err;
    }
  }

  private async writeFile(file: DatabaseFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), 'utf8');
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/database/file-database/file-transaction-repository.ts
git commit -m "feat(database): add FileTransactionRepository"
```

---

## Task 7: FilePositionRepository

**Files:**
- Create: `src/database/file-database/file-position-repository.ts`

- [ ] **Step 1: Implement `file-position-repository.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Position } from '../types';
import type { PositionRepository } from '../repositories/position-repository';

interface DatabaseFile {
  agents: unknown[];
  transactions: unknown[];
  positions: Position[];
}

export class FilePositionRepository implements PositionRepository {
  constructor(private readonly dbDir: string) {}

  async insert(pos: Position): Promise<void> {
    const file = await this.readFile();
    file.positions.push(pos);
    await this.writeFile(file);
  }

  async findOpen(agentId: string, tokenAddress: string): Promise<Position | null> {
    const file = await this.readFile();
    return (
      file.positions.find(
        (p) =>
          p.agentId === agentId &&
          p.amount.tokenAddress === tokenAddress &&
          p.closedAt === null,
      ) ?? null
    );
  }

  async listByAgent(agentId: string): Promise<Position[]> {
    const file = await this.readFile();
    return file.positions.filter((p) => p.agentId === agentId);
  }

  async update(pos: Position): Promise<void> {
    const file = await this.readFile();
    const idx = file.positions.findIndex((p) => p.id === pos.id);
    if (idx < 0) throw new Error(`Position ${pos.id} not found`);
    file.positions[idx] = pos;
    await this.writeFile(file);
  }

  private get path(): string {
    return join(this.dbDir, 'database.json');
  }

  private async readFile(): Promise<DatabaseFile> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as DatabaseFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { agents: [], transactions: [], positions: [] };
      }
      throw err;
    }
  }

  private async writeFile(file: DatabaseFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), 'utf8');
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/database/file-database/file-position-repository.ts
git commit -m "feat(database): add FilePositionRepository"
```

---

## Task 8: FileAgentMemoryRepository

**Files:**
- Create: `src/database/file-database/file-agent-memory-repository.ts`

Per-agent file: `db/memory/<agentId>.json`. Different storage layout from the agents/transactions/positions trio (those share `database.json`).

- [ ] **Step 1: Implement `file-agent-memory-repository.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentMemory } from '../types';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';

export class FileAgentMemoryRepository implements AgentMemoryRepository {
  constructor(private readonly dbDir: string) {}

  async get(agentId: string): Promise<AgentMemory | null> {
    try {
      const raw = await readFile(this.pathFor(agentId), 'utf8');
      return JSON.parse(raw) as AgentMemory;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async upsert(memory: AgentMemory): Promise<void> {
    const path = this.pathFor(memory.agentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(memory, null, 2), 'utf8');
  }

  private pathFor(agentId: string): string {
    return join(this.dbDir, 'memory', `${agentId}.json`);
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/database/file-database/file-agent-memory-repository.ts
git commit -m "feat(database): add FileAgentMemoryRepository (per-agent file)"
```

---

## Task 9: FileDatabase composition root + live test

**Files:**
- Create: `src/database/file-database/file-database.ts`
- Create: `src/database/file-database/file-database.live.test.ts`

This is the slice's only round-trip integration test. Exercises every repository against a real (tmpdir) filesystem.

- [ ] **Step 1: Implement `file-database.ts`**

```ts
import type { Database } from '../database';
import type { AgentRepository } from '../repositories/agent-repository';
import type { TransactionRepository } from '../repositories/transaction-repository';
import type { PositionRepository } from '../repositories/position-repository';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import { FileAgentRepository } from './file-agent-repository';
import { FileTransactionRepository } from './file-transaction-repository';
import { FilePositionRepository } from './file-position-repository';
import { FileAgentMemoryRepository } from './file-agent-memory-repository';

export class FileDatabase implements Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;

  constructor(dbDir: string) {
    this.agents = new FileAgentRepository(dbDir);
    this.transactions = new FileTransactionRepository(dbDir);
    this.positions = new FilePositionRepository(dbDir);
    this.agentMemory = new FileAgentMemoryRepository(dbDir);
  }
}
```

- [ ] **Step 2: Write the live round-trip test**

`src/database/file-database/file-database.live.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDatabase } from './file-database';
import type {
  AgentConfig,
  Transaction,
  Position,
  AgentMemory,
  TokenAmount,
} from '../types';

const usdc: TokenAmount = {
  tokenAddress: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  symbol: 'USDC',
  amountRaw: '1000000000',
  decimals: 6,
};

const uni: TokenAmount = {
  tokenAddress: '0x8f187aA05619a017077f5308904739877ce9eA21',
  symbol: 'UNI',
  amountRaw: '500000000000000000',
  decimals: 18,
};

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: `agent-${id}`,
    enabled: true,
    intervalMs: 180_000,
    prompt: 'do the thing',
    walletAddress: '0xabc',
    dryRun: true,
    dryRunSeedBalances: { native: '100000000000000000', [usdc.tokenAddress]: '1000000000' },
    riskLimits: { maxTradeUSD: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

function makeTx(id: string, agentId: string): Transaction {
  return {
    id,
    agentId,
    hash: `0x${'0'.repeat(60)}${id.padStart(4, '0')}`,
    chainId: 130,
    from: '0xabc',
    to: '0xdef',
    tokenIn: usdc,
    tokenOut: uni,
    gasUsed: '150000',
    gasPriceWei: '1000000000',
    gasCostWei: '150000000000000',
    status: 'success',
    blockNumber: null,
    timestamp: Date.now(),
  };
}

function makePos(id: string, agentId: string, openedByTx: string): Position {
  return {
    id,
    agentId,
    amount: uni,
    costBasisUSD: 50,
    openedByTransactionId: openedByTx,
    openedAt: Date.now(),
    closedAt: null,
    realizedPnlUSD: null,
  };
}

describe('FileDatabase (live, real filesystem)', () => {
  let dbDir: string;
  let db: FileDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-db-'));
    db = new FileDatabase(dbDir);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('round-trips an AgentConfig (upsert → list → findById)', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);

    const loaded = await db.agents.findById('a1');
    expect(loaded).toEqual(agent);

    const all = await db.agents.list();
    expect(all).toEqual([agent]);

    console.log('[file-database] agent round-trip OK:', loaded?.id);
  });

  it('upsert replaces existing agent by id (no duplicate)', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);
    await db.agents.upsert({ ...agent, name: 'renamed' });

    const all = await db.agents.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('renamed');
  });

  it('returns null for missing agent', async () => {
    expect(await db.agents.findById('nope')).toBeNull();
    expect(await db.agents.list()).toEqual([]);
  });

  it('round-trips Transactions (insert → findById → listByAgent)', async () => {
    await db.agents.upsert(makeAgent('a1'));
    const tx1 = makeTx('1', 'a1');
    const tx2 = makeTx('2', 'a1');
    const tx3 = makeTx('3', 'a2');
    await db.transactions.insert(tx1);
    await db.transactions.insert(tx2);
    await db.transactions.insert(tx3);

    expect(await db.transactions.findById('1')).toEqual(tx1);
    const a1 = await db.transactions.listByAgent('a1');
    expect(a1).toEqual([tx1, tx2]);
    const a1last = await db.transactions.listByAgent('a1', { limit: 1 });
    expect(a1last).toEqual([tx2]);

    console.log('[file-database] transactions for a1:', a1.length);
  });

  it('updates transaction status', async () => {
    const tx = makeTx('1', 'a1');
    await db.transactions.insert(tx);

    await db.transactions.updateStatus('1', {
      status: 'success',
      blockNumber: 42,
      hash: '0xabcd',
    });

    const loaded = await db.transactions.findById('1');
    expect(loaded?.status).toBe('success');
    expect(loaded?.blockNumber).toBe(42);
    expect(loaded?.hash).toBe('0xabcd');
  });

  it('round-trips Positions (insert → findOpen → listByAgent → update)', async () => {
    await db.agents.upsert(makeAgent('a1'));
    await db.transactions.insert(makeTx('1', 'a1'));
    const pos = makePos('p1', 'a1', '1');
    await db.positions.insert(pos);

    const open = await db.positions.findOpen('a1', uni.tokenAddress);
    expect(open).toEqual(pos);

    const all = await db.positions.listByAgent('a1');
    expect(all).toEqual([pos]);

    const closed = { ...pos, closedAt: Date.now(), closedByTransactionId: '2', realizedPnlUSD: 5 };
    await db.positions.update(closed);
    expect(await db.positions.findOpen('a1', uni.tokenAddress)).toBeNull();

    console.log('[file-database] position closed with PnL:', closed.realizedPnlUSD);
  });

  it('round-trips AgentMemory in its own per-agent file', async () => {
    const mem: AgentMemory = {
      agentId: 'a1',
      notes: 'short MA below long MA',
      state: { priceHistory: [3.21, 3.22, 3.20] },
      updatedAt: Date.now(),
    };
    await db.agentMemory.upsert(mem);

    const loaded = await db.agentMemory.get('a1');
    expect(loaded).toEqual(mem);

    expect(await db.agentMemory.get('nope')).toBeNull();

    // Verify the per-agent file actually exists at the documented path.
    const onDisk = JSON.parse(await readFile(join(dbDir, 'memory', 'a1.json'), 'utf8'));
    expect(onDisk.agentId).toBe('a1');
    console.log('[file-database] memory file OK for agent a1');
  });

  it('persists across FileDatabase instances (re-open)', async () => {
    await db.agents.upsert(makeAgent('a1'));
    await db.transactions.insert(makeTx('1', 'a1'));

    const db2 = new FileDatabase(dbDir);
    expect(await db2.agents.list()).toHaveLength(1);
    expect(await db2.transactions.findById('1')).not.toBeNull();
  });

  it('keeps agents, transactions, and positions in the SAME database.json', async () => {
    await db.agents.upsert(makeAgent('a1'));
    await db.transactions.insert(makeTx('1', 'a1'));
    await db.positions.insert(makePos('p1', 'a1', '1'));

    const onDisk = JSON.parse(await readFile(join(dbDir, 'database.json'), 'utf8'));
    expect(onDisk.agents).toHaveLength(1);
    expect(onDisk.transactions).toHaveLength(1);
    expect(onDisk.positions).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/database/file-database/`
Expected: PASS — 8 tests pass; round-trip logs printed.

- [ ] **Step 4: Commit**

```bash
git add src/database/file-database/file-database.ts src/database/file-database/file-database.live.test.ts
git commit -m "feat(database): add FileDatabase composition + live round-trip test"
```

---

## Task 10: ActivityLog types + interface

**Files:**
- Create: `src/agent-activity-log/types.ts`
- Create: `src/agent-activity-log/activity-log-store.ts`

- [ ] **Step 1: Create `src/agent-activity-log/types.ts`**

```ts
export type AgentActivityLogEntryType =
  | 'tick_start'
  | 'tick_end'
  | 'tool_call'
  | 'tool_result'
  | 'llm_call'
  | 'llm_response'
  | 'memory_update'
  | 'error';

export interface AgentActivityLogEntry {
  agentId: string;
  tickId: string;
  timestamp: number;
  type: AgentActivityLogEntryType;
  payload: Record<string, unknown>;
}
```

- [ ] **Step 2: Create `src/agent-activity-log/activity-log-store.ts`**

```ts
import type { AgentActivityLogEntry } from './types';

export interface ActivityLogStore {
  append(entry: AgentActivityLogEntry): Promise<void>;
  listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]>;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/agent-activity-log/types.ts src/agent-activity-log/activity-log-store.ts
git commit -m "feat(agent-activity-log): add types + ActivityLogStore interface"
```

---

## Task 11: FileActivityLogStore + live test

**Files:**
- Create: `src/agent-activity-log/file-activity-log-store.ts`
- Create: `src/agent-activity-log/file-activity-log-store.live.test.ts`

Append-only NDJSON: one JSON object per line. Cheap to append (`fs.appendFile`), trivial to parse line-by-line on read.

- [ ] **Step 1: Write the failing live test**

`src/agent-activity-log/file-activity-log-store.live.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileActivityLogStore } from './file-activity-log-store';
import type { AgentActivityLogEntry } from './types';

function makeEntry(agentId: string, tickId: string, type: AgentActivityLogEntry['type']): AgentActivityLogEntry {
  return {
    agentId,
    tickId,
    timestamp: Date.now(),
    type,
    payload: { note: `${type} for ${tickId}` },
  };
}

describe('FileActivityLogStore (live, real filesystem)', () => {
  let dbDir: string;
  let store: FileActivityLogStore;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-log-'));
    store = new FileActivityLogStore(dbDir);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('appends entries and reads them back in order', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a1', 't1', 'tool_call'));
    await store.append(makeEntry('a1', 't1', 'tick_end'));

    const entries = await store.listByAgent('a1');
    console.log('[activity-log] entries for a1:', entries.map((e) => e.type));
    expect(entries.map((e) => e.type)).toEqual(['tick_start', 'tool_call', 'tick_end']);
  });

  it('isolates entries per agent', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a2', 't9', 'tick_start'));

    const a1 = await store.listByAgent('a1');
    const a2 = await store.listByAgent('a2');
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(1);
    expect(a1[0]!.agentId).toBe('a1');
    expect(a2[0]!.agentId).toBe('a2');
  });

  it('returns empty array when agent has no log file', async () => {
    expect(await store.listByAgent('nobody')).toEqual([]);
  });

  it('limit returns the most recent N entries', async () => {
    for (let i = 0; i < 5; i++) await store.append(makeEntry('a1', `t${i}`, 'tick_start'));
    const last2 = await store.listByAgent('a1', { limit: 2 });
    expect(last2.map((e) => e.tickId)).toEqual(['t3', 't4']);
  });

  it('sinceTickId returns entries after the matching tickId', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a1', 't2', 'tick_start'));
    await store.append(makeEntry('a1', 't3', 'tick_start'));

    const after1 = await store.listByAgent('a1', { sinceTickId: 't1' });
    expect(after1.map((e) => e.tickId)).toEqual(['t2', 't3']);
  });

  it('writes NDJSON (one JSON object per line) to db/activity-log/<agentId>.json', async () => {
    await store.append(makeEntry('a1', 't1', 'tick_start'));
    await store.append(makeEntry('a1', 't1', 'tick_end'));

    const raw = await readFile(join(dbDir, 'activity-log', 'a1.json'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe('tick_start');
    expect(JSON.parse(lines[1]!).type).toBe('tick_end');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent-activity-log/`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `file-activity-log-store.ts`**

```ts
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ActivityLogStore } from './activity-log-store';
import type { AgentActivityLogEntry } from './types';

export class FileActivityLogStore implements ActivityLogStore {
  constructor(private readonly dbDir: string) {}

  async append(entry: AgentActivityLogEntry): Promise<void> {
    const path = this.pathFor(entry.agentId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
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
      const idx = entries.findIndex((e) => e.tickId === opts.sinceTickId);
      if (idx >= 0) entries = entries.slice(idx + 1);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent-activity-log/`
Expected: PASS — 6 tests pass; entries logged.

- [ ] **Step 5: Commit**

```bash
git add src/agent-activity-log/file-activity-log-store.ts src/agent-activity-log/file-activity-log-store.live.test.ts
git commit -m "feat(agent-activity-log): add FileActivityLogStore (NDJSON, append-only)"
```

---

## Task 12: AgentActivityLog typed-helper class

**Files:**
- Create: `src/agent-activity-log/agent-activity-log.ts`

Wraps `ActivityLogStore` with named methods per event type so callers don't have to assemble the entry by hand. No tests — exercised by future slice tasks.

- [ ] **Step 1: Implement `agent-activity-log.ts`**

```ts
import type { ActivityLogStore } from './activity-log-store';
import type { AgentActivityLogEntry, AgentActivityLogEntryType } from './types';

export class AgentActivityLog {
  constructor(private readonly store: ActivityLogStore) {}

  tickStart(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_start', payload);
  }

  tickEnd(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_end', payload);
  }

  toolCall(
    agentId: string,
    tickId: string,
    payload: { tool: string; input: unknown },
  ): Promise<void> {
    return this.write(agentId, tickId, 'tool_call', payload);
  }

  toolResult(
    agentId: string,
    tickId: string,
    payload: { tool: string; output: unknown; durationMs: number },
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
    payload: { model: string; responseChars: number; tokenCount?: number },
  ): Promise<void> {
    return this.write(agentId, tickId, 'llm_response', payload);
  }

  memoryUpdate(
    agentId: string,
    tickId: string,
    payload: { keysChanged: string[] },
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
    return this.store.listByAgent(agentId, opts);
  }

  private write(
    agentId: string,
    tickId: string,
    type: AgentActivityLogEntryType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.store.append({
      agentId,
      tickId,
      timestamp: Date.now(),
      type,
      payload,
    });
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/agent-activity-log/agent-activity-log.ts
git commit -m "feat(agent-activity-log): add AgentActivityLog typed-helper class"
```

---

## Task 13: Wire Database + ActivityLog into bootstrap

**Files:**
- Modify: `src/index.ts`

The empty looper logs each tick. Now have it also report how many agents are in the DB on each tick (smoke test that DB is wired up correctly). The activity log is constructed but unused this slice — Slice 4 (AgentRunner) will start writing to it.

- [ ] **Step 1: Update `src/index.ts`**

Current file:

```ts
import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';

function main(): void {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }
  console.log(`[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`);

  const looper = new Looper({
    tickIntervalMs: LOOPER.tickIntervalMs,
    onTick: async () => {
      console.log(`[looper] tick @ ${new Date().toISOString()} — no agents loaded`);
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
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';

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
  void activityLog;  // wired for slice 4; not used this slice

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);

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

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Manually verify bootstrap (with valid env override)**

Run:

```bash
WALLET_PRIVATE_KEY=0x$(printf '11%.0s' {1..32}) timeout 13 npm start || true
```

Expected output:

```
[bootstrap] env loaded — ZEROG_NETWORK=mainnet, DB_DIR=./db
[bootstrap] database + activity log initialized at ./db
[bootstrap] looper started, ticking every 10000ms
[looper] tick @ 2026-04-26T...Z — 0 agent(s) loaded
[bootstrap] received SIGTERM, stopping looper
```

(0 agents because `database.json` either doesn't exist yet or has an empty agents array.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire FileDatabase + AgentActivityLog into bootstrap"
```

---

## Task 14: Full sweep + tag

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all live tests pass; provider tests log UNI/USDC payloads (or skip when key missing); the new `file-database` and `file-activity-log-store` tests pass; `dry-run-hash` test passes; the Firecrawl 402 (if account still has no credits) is the only known failure.

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: exit code 0; `dist/` populated.

- [ ] **Step 3: Verify directory structure**

Run: `find src -type f | sort`
Expected (new files in **bold** versus slice 1):
```
src/agent-looper/looper.ts
**src/agent-activity-log/activity-log-store.ts**
**src/agent-activity-log/agent-activity-log.ts**
**src/agent-activity-log/file-activity-log-store.live.test.ts**
**src/agent-activity-log/file-activity-log-store.ts**
**src/agent-activity-log/types.ts**
src/config/env.ts
src/constants/fee-tiers.ts
src/constants/index.ts
src/constants/looper.ts
src/constants/tokens.ts
src/constants/unichain.ts
src/constants/zerog-networks.ts
**src/database/database.ts**
**src/database/file-database/file-agent-memory-repository.ts**
**src/database/file-database/file-agent-repository.ts**
**src/database/file-database/file-database.live.test.ts**
**src/database/file-database/file-database.ts**
**src/database/file-database/file-position-repository.ts**
**src/database/file-database/file-transaction-repository.ts**
**src/database/repositories/agent-memory-repository.ts**
**src/database/repositories/agent-repository.ts**
**src/database/repositories/position-repository.ts**
**src/database/repositories/transaction-repository.ts**
**src/database/types.ts**
src/index.ts
src/providers/coingecko/coingecko-service.live.test.ts
src/providers/coingecko/coingecko-service.ts
src/providers/coinmarketcap/coinmarketcap-service.live.test.ts
src/providers/coinmarketcap/coinmarketcap-service.ts
src/providers/firecrawl/firecrawl-service.live.test.ts
src/providers/firecrawl/firecrawl-service.ts
src/providers/serper/serper-service.live.test.ts
src/providers/serper/serper-service.ts
**src/wallet/dry-run/dry-run-hash.live.test.ts**
**src/wallet/dry-run/dry-run-hash.ts**
```

(Strip the `**` markdown markers when comparing — they aren't in the actual paths.)

- [ ] **Step 4: Tag the slice**

```bash
git tag slice-2-database
```

- [ ] **Step 5: Final log inspection**

Run: `git log --oneline slice-1-bootstrap..HEAD`
Expected: 13 new commits (Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13). Order does not matter for correctness, only that each commit is present.

---

## Out of Scope for Slice 2

Deferred to later slices:
- `WalletFactory` and `DryRunWallet` itself — Slice 3 (Wallet)
- `RealWallet` — Slice 3
- AgentRunner that actually consumes Database + AgentActivityLog — Slice 4
- 0G bootstrap state file (`zerog-bootstrap.json`) — Slice 5 (its consumer is `ZeroGBrokerService`)
- Activity log rotation — single file per agent is fine for v1
- Atomic writes (`fs.rename` pattern) — moving to a real DB before torn-write risk matters
- `AgentRepository.delete()` — operators clear the DB by hand in v1

---

## Self-Review

**Spec coverage check:**
- ✅ `Database` interface composing 4 repositories — Tasks 2 + 3
- ✅ All 4 repository interfaces with the spec's exact method signatures — Task 2
- ✅ `AgentRepository` has no `delete()` — Task 2 (matches spec lock-in)
- ✅ Domain types include `TokenAmount`, `Position.amount` uses it, `Position` references opening + closing transactions — Task 1
- ✅ `Transaction.hash` is non-nullable — Task 1
- ✅ `FileDatabase` storage layout matches spec: `db/database.json` + `db/memory/<id>.json` + `db/activity-log/<id>.json` — Tasks 5–9, 11
- ✅ `agent-activity-log/` is its own module with `ActivityLogStore` interface — Tasks 10, 11
- ✅ `AgentActivityLog` typed-helper with named methods per event type — Task 12
- ✅ `generateDryRunHash` lives in `wallet/dry-run/` (producer), no consumer-side filter helper — Task 4
- ✅ DryRunWallet replays all txs (no filter) — handled in Slice 3, but the `dry-run-hash` regex existing in this slice supports operator inspection per spec
- ✅ Bootstrap wires both modules — Task 13

**Placeholder scan:** No TBDs, no "implement later". Every step has actual code or an exact command.

**Type consistency:**
- `AgentConfig`, `Transaction`, `Position`, `AgentMemory`, `TokenAmount` defined once in `database/types.ts` (Task 1) and reused everywhere
- Repository interfaces in Task 2 use those types via `import type`
- `FileDatabase` (Task 9) implements `Database` (Task 3) by composing the 4 file-backed repos (Tasks 5–8)
- `FileActivityLogStore` (Task 11) implements `ActivityLogStore` (Task 10) and uses `AgentActivityLogEntry` from `types.ts` (Task 10)
- `Position.amount.tokenAddress` is the lookup key in `findOpen(agentId, tokenAddress)` — consistent across interface and impl
- `AgentActivityLogEntry.tickId: string` is consistent across types, store interface, and helper class
