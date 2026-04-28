# Privy Users + Wallet Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `User` + `UserWallet` tables, Privy JWT auth middleware, `POST /users/me/wallets` endpoint, and a `wallet/privy/` module that signs via Privy server-wallet API. `WalletFactory.forAgent` keeps the env-key path; the Privy cutover is a follow-up spec.

**Architecture:** Domain types + repositories first (DB layer), then Privy auth in API middleware, then the wallet provisioning endpoint, then the wallet module (built but not runtime-wired). All Privy calls live behind classes (`PrivyAuth`, `WalletProvisioner`, `PrivyServerWallet`, `PrivyWalletFactory`) to keep route handlers and the runtime simple. The looper does not see Privy at all.

**Tech Stack:** TypeScript 5.x, Node 20+, Prisma 6, Postgres 16, vitest, Express, `@privy-io/server-auth` SDK, viem.

**Spec reference:** [docs/superpowers/specs/2026-04-28-privy-users-wallets-design.md](../specs/2026-04-28-privy-users-wallets-design.md)

**Test rule:** Live tests skip when `PRIVY_APP_ID`/`PRIVY_APP_SECRET` (Privy tests) or `TEST_DATABASE_URL` (DB tests) are missing. `npm test` stays safe with no env vars set.

---

## File Structure

```
prisma/
  schema.prisma                                  + User, UserWallet, Agent.userId
  migrations/<ts>_add_users_userwallets/
    migration.sql                                auto-generated
  seed.ts                                        creates dev User first

src/
  config/
    env.ts                                       + PRIVY_APP_ID, PRIVY_APP_SECRET (optional, refined at bootstrap)

  database/
    types.ts                                     + User, UserWallet; Agent gains userId
    database.ts                                  + users, userWallets fields
    repositories/
      user-repository.ts                         NEW
      user-wallet-repository.ts                  NEW
    prisma-database/
      prisma-user-repository.ts                  NEW
      prisma-user-wallet-repository.ts           NEW
      prisma-database.ts                         + composes both
      mappers.ts                                 + user/userWallet mappers; Agent mapper gains userId
      prisma-database.live.test.ts               + user + userWallet round-trip tests

  api-server/
    auth/                                        NEW directory
      privy-auth.ts                              JWT verification wrapper
      privy-auth.live.test.ts                    skip when PRIVY_APP_* missing
    middleware/
      auth.ts                                    Privy verification + upsert User; req.user typed as User
    routes/
      users.ts                                   NEW: GET /users/me, POST /users/me/wallets
      agents.ts                                  + ownership filter on list, set userId on create
    server.ts                                    + privyAuth, walletProvisioner deps

  wallet/
    privy/                                       NEW
      privy-server-wallet.ts                     Wallet impl
      privy-wallet-factory.ts                    forUserWallet(uw)
      wallet-provisioner.ts                      provisionPrimary(userId)
      privy-server-wallet.live.test.ts           skip when PRIVY_APP_* missing
      privy-wallet-factory.live.test.ts          skip when PRIVY_APP_* missing
    factory/
      wallet-factory.ts                          + transitional comment

  index.ts                                       + Privy client + provisioner; refines required env per MODE

scripts/
  lib/
    seed-uni-ma-trader.ts                        + required userId on produced AgentConfig

.env.example                                     + PRIVY_APP_ID, PRIVY_APP_SECRET
CLAUDE.md                                        + Privy + users section
```

---

## Phase 0 — DB layer

### Task 1: Domain types — add `User`, `UserWallet`, `AgentConfig.userId`

**Files:**
- Modify: `src/database/types.ts`

- [ ] **Step 1: Append User + UserWallet, add userId to AgentConfig**

```typescript
// src/database/types.ts — at top, modify AgentConfig
export interface AgentConfig {
  id: string;
  userId: string;             // NEW — required FK
  name: string;
  prompt: string;
  // ... rest unchanged
}

// at bottom of file, append:
export interface User {
  id: string;
  privyDid: string;
  email: string | null;
  createdAt: number;
}

export interface UserWallet {
  id: string;
  userId: string;
  privyWalletId: string;
  walletAddress: string;
  isPrimary: boolean;
  createdAt: number;
}
```

- [ ] **Step 2: Verify typecheck breaks (expected)**

Run: `npm run typecheck`
Expected: errors about `userId` missing on AgentConfig in many fixtures + builders. We'll fix in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/database/types.ts
git commit -m "feat(domain): add User, UserWallet types; AgentConfig.userId required"
```

---

### Task 2: Prisma schema — add models + Agent.userId

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add User + UserWallet models, add userId to Agent**

In `prisma/schema.prisma`, modify the `Agent` model to add `userId` and a relation (insert below the existing scalar fields, before the back-relations block):

```prisma
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

  userId              String
  user                User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  transactions        Transaction[]
  positions           Position[]
  memory              AgentMemory?
  events              ActivityEvent[]

  @@index([userId])
}
```

At the bottom of `prisma/schema.prisma`, append the two new models:

```prisma
model User {
  id          String   @id
  privyDid    String   @unique
  email       String?
  createdAt   BigInt

  wallets     UserWallet[]
  agents      Agent[]
}

model UserWallet {
  id              String   @id
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  privyWalletId   String   @unique
  walletAddress   String
  isPrimary       Boolean  @default(false)
  createdAt       BigInt

  @@index([userId])
  @@index([userId, isPrimary])
}
```

- [ ] **Step 2: Validate schema**

Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 3: Generate + apply migration (against dev DB and test DB)**

```bash
npm run db:reset                                        # wipes + reseeds (seed will fail; that's fine)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop npx prisma migrate dev --name add_users_userwallets --skip-seed
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npx prisma migrate deploy
```

Expected: migration applied; `prisma/migrations/<ts>_add_users_userwallets/migration.sql` exists.

The `db:reset` is needed because the migration adds `userId NOT NULL` to a non-empty `Agent` table (the seed agent). After reset, the existing agent is gone; the new migration applies cleanly.

- [ ] **Step 4: Verify the SQL**

Read `prisma/migrations/<ts>_add_users_userwallets/migration.sql`. Confirm:
- `CREATE TABLE "User"` with `privyDid UNIQUE`
- `CREATE TABLE "UserWallet"` with `privyWalletId UNIQUE`
- `ALTER TABLE "Agent" ADD COLUMN "userId" TEXT NOT NULL`
- `ADD CONSTRAINT "Agent_userId_fkey"` with `ON DELETE CASCADE`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add User, UserWallet tables; Agent.userId FK"
```

---

### Task 3: Repository interfaces

**Files:**
- Create: `src/database/repositories/user-repository.ts`
- Create: `src/database/repositories/user-wallet-repository.ts`

- [ ] **Step 1: Write `user-repository.ts`**

```typescript
// src/database/repositories/user-repository.ts
import type { User } from '../types';

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByPrivyDid(privyDid: string): Promise<User | null>;
  findOrCreateByPrivyDid(
    privyDid: string,
    claims: { email?: string },
  ): Promise<User>;
}
```

- [ ] **Step 2: Write `user-wallet-repository.ts`**

```typescript
// src/database/repositories/user-wallet-repository.ts
import type { UserWallet } from '../types';

export interface UserWalletRepository {
  insert(uw: UserWallet): Promise<void>;
  findById(id: string): Promise<UserWallet | null>;
  findPrimaryByUser(userId: string): Promise<UserWallet | null>;
  listByUser(userId: string): Promise<UserWallet[]>;
  findByPrivyWalletId(privyWalletId: string): Promise<UserWallet | null>;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: still has the `AgentConfig.userId` errors but no new errors from these two files (they're not yet imported anywhere).

- [ ] **Step 4: Commit**

```bash
git add src/database/repositories/user-repository.ts src/database/repositories/user-wallet-repository.ts
git commit -m "feat(db): UserRepository + UserWalletRepository interfaces"
```

---

### Task 4: Database interface + PrismaDatabase composer

**Files:**
- Modify: `src/database/database.ts`
- Modify: `src/database/prisma-database/prisma-database.ts`

- [ ] **Step 1: Add fields to `Database` interface**

```typescript
// src/database/database.ts
import type { AgentRepository } from './repositories/agent-repository';
import type { TransactionRepository } from './repositories/transaction-repository';
import type { PositionRepository } from './repositories/position-repository';
import type { AgentMemoryRepository } from './repositories/agent-memory-repository';
import type { ActivityLogRepository } from './repositories/activity-log-repository';
import type { UserRepository } from './repositories/user-repository';
import type { UserWalletRepository } from './repositories/user-wallet-repository';

export interface Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;
  readonly users: UserRepository;
  readonly userWallets: UserWalletRepository;
}
```

- [ ] **Step 2: Add fields to `PrismaDatabase`**

```typescript
// src/database/prisma-database/prisma-database.ts — add imports + fields
import { PrismaUserRepository } from './prisma-user-repository';
import { PrismaUserWalletRepository } from './prisma-user-wallet-repository';

// inside class, alongside existing readonly fields:
  readonly users: UserRepository;
  readonly userWallets: UserWalletRepository;

// inside constructor, alongside existing assignments:
    this.users = new PrismaUserRepository(prisma);
    this.userWallets = new PrismaUserWalletRepository(prisma);
```

Add the `UserRepository` and `UserWalletRepository` imports at the top of the file.

- [ ] **Step 3: Typecheck will fail (expected)**

Run: `npm run typecheck`
Expected: errors about missing `PrismaUserRepository` / `PrismaUserWalletRepository` files — implemented in Tasks 6 + 7.

- [ ] **Step 4: Commit (with broken typecheck, fixed in next tasks)**

Skip commit until Task 7 lands the impls. Stage but don't commit:

```bash
git add src/database/database.ts src/database/prisma-database/prisma-database.ts
```

---

### Task 5: Mappers — user, userWallet, agent.userId

**Files:**
- Modify: `src/database/prisma-database/mappers.ts`

- [ ] **Step 1: Add userId to agent mapper**

Edit `agentRowToDomain` to include `userId: row.userId`:

```typescript
export function agentRowToDomain(row: PrismaAgent): AgentConfig {
  return {
    id: row.id,
    userId: row.userId,
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
```

- [ ] **Step 2: Append user + userWallet mappers**

At the bottom of `mappers.ts`, append:

```typescript
import type {
  User as PrismaUser,
  UserWallet as PrismaUserWallet,
} from '@prisma/client';
import type { User, UserWallet } from '../types';

export function userRowToDomain(row: PrismaUser): User {
  return {
    id: row.id,
    privyDid: row.privyDid,
    email: row.email,
    createdAt: numReq(row.createdAt),
  };
}

export function userWalletRowToDomain(row: PrismaUserWallet): UserWallet {
  return {
    id: row.id,
    userId: row.userId,
    privyWalletId: row.privyWalletId,
    walletAddress: row.walletAddress,
    isPrimary: row.isPrimary,
    createdAt: numReq(row.createdAt),
  };
}
```

(Move the `import type { ... }` for `PrismaUser`/`PrismaUserWallet` up into the existing `from '@prisma/client'` import block at the top of the file to keep imports clean.)

- [ ] **Step 3: Typecheck**

Run: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop npx prisma generate && npm run typecheck`
Expected: still has the `PrismaUserRepository` import errors; mappers themselves compile fine.

- [ ] **Step 4: Stage (don't commit yet — paired with Task 6+7)**

```bash
git add src/database/prisma-database/mappers.ts
```

---

### Task 6: `PrismaUserRepository` (TDD)

**Files:**
- Create: `src/database/prisma-database/prisma-user-repository.ts`
- Modify: `src/database/prisma-database/prisma-database.live.test.ts` (append test block)

- [ ] **Step 1: Append failing test to `prisma-database.live.test.ts`**

```typescript
// append at end of src/database/prisma-database/prisma-database.live.test.ts
import { PrismaUserRepository } from './prisma-user-repository';
import type { User } from '../types';

describeIfPostgres('PrismaUserRepository', () => {
  const prisma = getTestPrisma()!;
  const users = new PrismaUserRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('findOrCreateByPrivyDid creates a row on first call', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'a@b.c' });
    expect(u.privyDid).toBe('did:privy:abc');
    expect(u.email).toBe('a@b.c');
    expect(u.id).toBeTruthy();
    console.log('user.findOrCreateByPrivyDid →', u);
  });

  it('findOrCreateByPrivyDid is idempotent', async () => {
    const a = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'a@b.c' });
    const b = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'a@b.c' });
    expect(b.id).toBe(a.id);
  });

  it('findOrCreateByPrivyDid updates email on second call when changed', async () => {
    await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'old@x.com' });
    const updated = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'new@x.com' });
    expect(updated.email).toBe('new@x.com');
  });

  it('findByPrivyDid returns null for unknown DID', async () => {
    expect(await users.findByPrivyDid('did:privy:nope')).toBeNull();
  });

  it('findById returns null for unknown id', async () => {
    expect(await users.findById('not-a-real-id')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npm test -- prisma-database.live`
Expected: import error.

- [ ] **Step 3: Implement**

```typescript
// src/database/prisma-database/prisma-user-repository.ts
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { User } from '../types';
import type { UserRepository } from '../repositories/user-repository';
import { userRowToDomain } from './mappers';

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? userRowToDomain(row) : null;
  }

  async findByPrivyDid(privyDid: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { privyDid } });
    return row ? userRowToDomain(row) : null;
  }

  async findOrCreateByPrivyDid(
    privyDid: string,
    claims: { email?: string },
  ): Promise<User> {
    const row = await this.prisma.user.upsert({
      where: { privyDid },
      create: {
        id: randomUUID(),
        privyDid,
        email: claims.email ?? null,
        createdAt: BigInt(Date.now()),
      },
      update: {
        email: claims.email ?? null,
      },
    });
    return userRowToDomain(row);
  }
}
```

- [ ] **Step 4: Run, watch pass**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npm test -- prisma-database.live`
Expected: 5 new tests pass (plus all previously-passing tests).

- [ ] **Step 5: Stage (still don't commit — Task 7 batches with this)**

```bash
git add src/database/prisma-database/prisma-user-repository.ts src/database/prisma-database/prisma-database.live.test.ts
```

---

### Task 7: `PrismaUserWalletRepository` (TDD)

**Files:**
- Create: `src/database/prisma-database/prisma-user-wallet-repository.ts`
- Modify: `src/database/prisma-database/prisma-database.live.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
// append at end of src/database/prisma-database/prisma-database.live.test.ts
import { PrismaUserWalletRepository } from './prisma-user-wallet-repository';
import type { UserWallet } from '../types';
import { randomUUID } from 'node:crypto';

describeIfPostgres('PrismaUserWalletRepository', () => {
  const prisma = getTestPrisma()!;
  const users = new PrismaUserRepository(prisma);
  const wallets = new PrismaUserWalletRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  function makeWallet(opts: { userId: string; privyWalletId?: string; isPrimary?: boolean }): UserWallet {
    return {
      id: randomUUID(),
      userId: opts.userId,
      privyWalletId: opts.privyWalletId ?? randomUUID(),
      walletAddress: '0xabc',
      isPrimary: opts.isPrimary ?? true,
      createdAt: Date.now(),
    };
  }

  it('insert + findById round-trip', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    const w = makeWallet({ userId: u.id });
    await wallets.insert(w);
    const got = await wallets.findById(w.id);
    expect(got?.privyWalletId).toBe(w.privyWalletId);
    expect(got?.isPrimary).toBe(true);
    console.log('userWallet.findById →', got);
  });

  it('findPrimaryByUser returns the primary wallet, ignores non-primary', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    await wallets.insert(makeWallet({ userId: u.id, isPrimary: false }));
    const primary = makeWallet({ userId: u.id, isPrimary: true });
    await wallets.insert(primary);
    const got = await wallets.findPrimaryByUser(u.id);
    expect(got?.id).toBe(primary.id);
  });

  it('findPrimaryByUser returns null when user has no wallets', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    expect(await wallets.findPrimaryByUser(u.id)).toBeNull();
  });

  it('listByUser returns all wallets for the user', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    await wallets.insert(makeWallet({ userId: u.id, isPrimary: true }));
    await wallets.insert(makeWallet({ userId: u.id, isPrimary: false }));
    const all = await wallets.listByUser(u.id);
    expect(all).toHaveLength(2);
  });

  it('privyWalletId uniqueness is enforced', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    const shared = 'privy-wallet-shared';
    await wallets.insert(makeWallet({ userId: u.id, privyWalletId: shared }));
    await expect(
      wallets.insert(makeWallet({ userId: u.id, privyWalletId: shared })),
    ).rejects.toThrow();
  });

  it('findByPrivyWalletId returns the row', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    const w = makeWallet({ userId: u.id, privyWalletId: 'pw-1' });
    await wallets.insert(w);
    const got = await wallets.findByPrivyWalletId('pw-1');
    expect(got?.id).toBe(w.id);
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npm test -- prisma-database.live`

- [ ] **Step 3: Implement**

```typescript
// src/database/prisma-database/prisma-user-wallet-repository.ts
import type { PrismaClient } from '@prisma/client';
import type { UserWallet } from '../types';
import type { UserWalletRepository } from '../repositories/user-wallet-repository';
import { userWalletRowToDomain } from './mappers';

export class PrismaUserWalletRepository implements UserWalletRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(uw: UserWallet): Promise<void> {
    await this.prisma.userWallet.create({
      data: {
        id: uw.id,
        userId: uw.userId,
        privyWalletId: uw.privyWalletId,
        walletAddress: uw.walletAddress,
        isPrimary: uw.isPrimary,
        createdAt: BigInt(uw.createdAt),
      },
    });
  }

  async findById(id: string): Promise<UserWallet | null> {
    const row = await this.prisma.userWallet.findUnique({ where: { id } });
    return row ? userWalletRowToDomain(row) : null;
  }

  async findPrimaryByUser(userId: string): Promise<UserWallet | null> {
    const row = await this.prisma.userWallet.findFirst({
      where: { userId, isPrimary: true },
    });
    return row ? userWalletRowToDomain(row) : null;
  }

  async listByUser(userId: string): Promise<UserWallet[]> {
    const rows = await this.prisma.userWallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(userWalletRowToDomain);
  }

  async findByPrivyWalletId(privyWalletId: string): Promise<UserWallet | null> {
    const row = await this.prisma.userWallet.findUnique({ where: { privyWalletId } });
    return row ? userWalletRowToDomain(row) : null;
  }
}
```

- [ ] **Step 4: Run, watch pass**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npm test -- prisma-database.live`
Expected: all 6 new tests pass.

- [ ] **Step 5: Commit Tasks 4–7 together**

```bash
git add src/database/prisma-database/prisma-user-wallet-repository.ts \
        src/database/prisma-database/prisma-database.live.test.ts \
        src/database/database.ts \
        src/database/prisma-database/prisma-database.ts \
        src/database/prisma-database/mappers.ts \
        src/database/prisma-database/prisma-user-repository.ts
git commit -m "feat(db): PrismaUserRepository + PrismaUserWalletRepository + Database wiring + mappers"
```

---

### Task 8: Update existing AgentConfig consumers for `userId`

**Files:**
- Modify: `src/api-server/routes/agents.ts` (create endpoint must set `userId`)
- Modify: `src/api-server/openapi/schemas.ts` (`AgentConfigSchema` adds `userId`)
- Modify: every test fixture that constructs `AgentConfig` (the typecheck errors from Task 1 give the list)

- [ ] **Step 1: Get the full list of typecheck errors**

Run: `npm run typecheck 2>&1 | grep -E "userId|AgentConfig" | head -30`

You should see fixtures in `src/wallet/dry-run/dry-run-wallet.live.test.ts`, `src/wallet/factory/wallet-factory.live.test.ts`, `src/agent-looper/agent-orchestrator.live.test.ts`, `src/agent-runner/agent-runner.live.test.ts`, `src/ai-tools/tool-registry.live.test.ts`, `src/database/prisma-database/prisma-database.live.test.ts`, `src/uniswap/position-tracker.test.ts`, and the route handler.

- [ ] **Step 2: Add `userId` to the test fixture in `prisma-database.live.test.ts`**

In every place a `Transaction` test does `await agents.upsert({...})` or `await users.findOrCreateByPrivyDid(...)`, the agent fixture needs `userId`. Pattern:

```typescript
beforeEach(async () => {
  await truncateAll(prisma);
  const u = await users.findOrCreateByPrivyDid('did:privy:test', {});
  await agents.upsert({
    id: 'a1', userId: u.id, name: 'a1', prompt: '', dryRun: true,
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
  });
});
```

The `Transaction`, `Position`, `AgentMemory` test blocks all need this swap. Add `import { PrismaUserRepository } from './prisma-user-repository';` if not already present, and `const users = new PrismaUserRepository(prisma);` at the top of those `describeIfPostgres` blocks.

- [ ] **Step 3: Add `userId` to the wallet/factory/runner/orchestrator/tool-registry test fixtures**

These tests construct `AgentConfig` directly without going through the DB — they don't need a real `User` row. Use a fixed string `'user-test'`:

For each affected test, find the agent fixture (often a `makeAgent` helper) and add:
```typescript
userId: 'user-test',
```

In `src/agent-looper/agent-orchestrator.live.test.ts` and `src/agent-runner/agent-runner.live.test.ts` the agents are inserted via `db.agents.upsert(...)`. With the `Agent.userId` FK, this insert will now fail unless a corresponding `User` row exists. So in these test setups, after constructing `db = new PrismaDatabase(prisma!)`, do:

```typescript
await db.users.findOrCreateByPrivyDid('did:privy:test', {});
const TEST_USER = (await db.users.findByPrivyDid('did:privy:test'))!;
// then in fixtures:
userId: TEST_USER.id,
```

(Inline the user creation inside `beforeEach` so it survives the truncate.)

For `src/ai-tools/tool-registry.live.test.ts`, same pattern: create a user before upserting agents.

For `src/uniswap/position-tracker.test.ts`, this is a unit test using a partial-mock `Database` — just add `userId: 'user-test'` to the agent literal.

- [ ] **Step 4: Add `userId` to the API route handler**

In `src/api-server/routes/agents.ts`, the `POST /` handler builds an `AgentConfig` literal — add `userId: req.user!.id`:

```typescript
const agent: AgentConfig = {
  id: randomUUID(),
  userId: req.user!.id,
  name: body.name,
  // ... rest
};
```

Also: filter `r.get('/')` (list) by user:

```typescript
r.get('/', async (req, res, next) => {
  try {
    const all = await deps.db.agents.list();
    const owned = all.filter((a) => a.userId === req.user!.id);
    res.json(owned);
  } catch (err) { next(err); }
});
```

(A future spec can add `db.agents.listByUser(userId)` for SQL-side filtering. For now, in-memory filter is fine — there's no production load.)

- [ ] **Step 5: Add `userId` to OpenAPI schema**

In `src/api-server/openapi/schemas.ts`, modify `AgentConfigSchema`:

```typescript
export const AgentConfigSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  // ... rest unchanged
}).openapi('AgentConfig');
```

`CreateAgentBodySchema` does NOT add `userId` — the server populates it from `req.user`.

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Run tests**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_loop_test npm test 2>&1 | tail -10`
Expected: all DB-touching tests pass (modulo Firecrawl 402 flake).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(domain): wire AgentConfig.userId through fixtures, route, OpenAPI schema"
```

---

## Phase 1 — Seed

### Task 9: Update seed for required `userId`

**Files:**
- Modify: `prisma/seed.ts`
- Modify: `scripts/lib/seed-uni-ma-trader.ts`

- [ ] **Step 1: Update `seed-uni-ma-trader.ts` to require + set `userId`**

```typescript
// scripts/lib/seed-uni-ma-trader.ts
export interface SeedAgentOptions {
  dryRun?: boolean;
  now?: number;
  userId: string;            // NEW required
}

export function buildSeedAgentConfig(opts: SeedAgentOptions): AgentConfig {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? Date.now();
  return {
    id: SEED_AGENT_ID,
    userId: opts.userId,
    name: 'UNI Moving Average Trader',
    // ... rest unchanged
  };
}
```

- [ ] **Step 2: Update `prisma/seed.ts` to create dev user first**

```typescript
// prisma/seed.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { confirmContinue } from '../src/test-lib/interactive-prompt';
import { buildSeedAgentConfig, SEED_AGENT_ID } from '../scripts/lib/seed-uni-ma-trader';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';
import { PrismaUserRepository } from '../src/database/prisma-database/prisma-user-repository';

const DEV_USER_DID = 'did:privy:dev-local';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const users = new PrismaUserRepository(prisma);
    const agents = new PrismaAgentRepository(prisma);

    const existing = await agents.findById(SEED_AGENT_ID);
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

    const devUser = await users.findOrCreateByPrivyDid(DEV_USER_DID, { email: 'dev@local' });
    console.log(`[seed] dev user: ${devUser.id} (${DEV_USER_DID})`);

    const seed = buildSeedAgentConfig({ dryRun, userId: devUser.id });
    await agents.upsert(seed);

    console.log(`[seed] installed agent "${seed.id}" (dryRun=${dryRun}) for user ${devUser.id}.`);
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

- [ ] **Step 3: Smoke test**

```bash
npm run db:reset
```

Expected: prompt y/n; answer `y`; output shows dev user id + seeded agent for that user.

Verify:
```bash
docker exec agent-loop-postgres psql -U postgres -d agent_loop -c '
  SELECT u.id AS user_id, u."privyDid", a.id AS agent_id, a.name FROM "User" u JOIN "Agent" a ON a."userId" = u.id;'
```
Expected: one row joining the dev user with the seed agent.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts scripts/lib/seed-uni-ma-trader.ts
git commit -m "feat(seed): create dev User row and assign seed agent to it"
```

---

## Phase 2 — Privy auth

### Task 10: Install `@privy-io/server-auth` + add env vars

**Files:**
- Modify: `package.json`
- Modify: `src/config/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install SDK**

```bash
npm install @privy-io/server-auth
```

- [ ] **Step 2: Add env vars (zod schema)**

```typescript
// src/config/env.ts — add inside z.object({ ... })
PRIVY_APP_ID: z.string().min(1).optional(),
PRIVY_APP_SECRET: z.string().min(1).optional(),
```

- [ ] **Step 3: Append to `.env.example`**

```bash
cat >> .env.example <<'EOF'

# Privy (required when MODE=server or MODE=both)
PRIVY_APP_ID=
PRIVY_APP_SECRET=
EOF
```

- [ ] **Step 4: Add to local `.env`** (manually; do not commit)

Add `PRIVY_APP_ID=` and `PRIVY_APP_SECRET=` (real values from Privy dashboard) to your local `.env`. If you don't have a Privy app yet, leave them blank — `MODE=looper` still works.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config/env.ts .env.example
git commit -m "feat(config): install @privy-io/server-auth; add PRIVY_APP_ID/SECRET to env"
```

---

### Task 11: `PrivyAuth` JWT wrapper (TDD against real Privy dev app)

**Files:**
- Create: `src/api-server/auth/privy-auth.ts`
- Create: `src/api-server/auth/privy-auth.live.test.ts`

- [ ] **Step 1: Write failing test (skip when env missing)**

```typescript
// src/api-server/auth/privy-auth.live.test.ts
import { describe, it, expect } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrivyAuth } from './privy-auth';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const TEST_TOKEN = process.env.PRIVY_TEST_TOKEN; // signed JWT from a real test login

describe.skipIf(!APP_ID || !APP_SECRET || !TEST_TOKEN)('PrivyAuth (live)', () => {
  const auth = new PrivyAuth(new PrivyClient(APP_ID!, APP_SECRET!));

  it('verifyToken returns DID for a valid token', async () => {
    const { did } = await auth.verifyToken(TEST_TOKEN!);
    expect(did).toMatch(/^did:privy:/);
    console.log('[privy-auth] verified DID:', did);
  });

  it('verifyToken throws on a malformed token', async () => {
    await expect(auth.verifyToken('not.a.real.token')).rejects.toThrow();
  });
});
```

(`PRIVY_TEST_TOKEN` is a one-time JWT obtained by logging into your Privy dev app from a frontend or via Privy's test-token utility. The test skips if you don't have one.)

- [ ] **Step 2: Run, watch fail (or skip)**

Run: `npm test -- privy-auth.live`
Expected: skip if `PRIVY_TEST_TOKEN` missing; otherwise fail with import error.

- [ ] **Step 3: Implement**

```typescript
// src/api-server/auth/privy-auth.ts
import type { PrivyClient } from '@privy-io/server-auth';

export class PrivyAuth {
  constructor(private readonly client: PrivyClient) {}

  async verifyToken(bearer: string): Promise<{ did: string }> {
    const claims = await this.client.verifyAuthToken(bearer);
    return { did: claims.userId };
  }

  async getEmail(did: string): Promise<string | undefined> {
    try {
      const user = await this.client.getUser(did);
      const linked = user.linkedAccounts?.find((a) => a.type === 'email');
      return linked && 'address' in linked ? (linked.address as string) : undefined;
    } catch {
      return undefined;
    }
  }
}
```

- [ ] **Step 4: Run, watch pass (or stay skipped)**

Run: `npm test -- privy-auth.live`
Expected: 2 tests pass when env is set; otherwise the suite skips.

- [ ] **Step 5: Commit**

```bash
git add src/api-server/auth/privy-auth.ts src/api-server/auth/privy-auth.live.test.ts
git commit -m "feat(auth): PrivyAuth JWT verification wrapper + live test"
```

---

### Task 12: Refactor auth middleware to use `PrivyAuth` + upsert User

**Files:**
- Modify: `src/api-server/middleware/auth.ts`

- [ ] **Step 1: Rewrite middleware**

```typescript
// src/api-server/middleware/auth.ts
import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { AgentConfig, User } from '../../database/types';
import type { UserRepository } from '../../database/repositories/user-repository';
import type { PrivyAuth } from '../auth/privy-auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'ForbiddenError';
  }
}

export function buildAuthMiddleware(
  privyAuth: PrivyAuth,
  users: UserRepository,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const token = header.slice(7);
    let did: string;
    try {
      const verified = await privyAuth.verifyToken(token);
      did = verified.did;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    try {
      const email = await privyAuth.getEmail(did);
      const user = await users.findOrCreateByPrivyDid(did, { email });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function assertAgentOwnedBy(agent: AgentConfig, user: User): void {
  if (agent.userId !== user.id) throw new ForbiddenError();
}
```

The old exported `ApiUser` interface and `STUB_USER` are gone. The old top-level `authMiddleware` function is replaced by the `buildAuthMiddleware` factory; route consumers use `req.user!.id` (still works because `User` has an `id` field).

- [ ] **Step 2: Verify typecheck — expect new errors in `server.ts`**

Run: `npm run typecheck`
Expected: errors in `src/api-server/server.ts` — it still imports `authMiddleware` (now removed). Fix in Task 17.

- [ ] **Step 3: Stage (don't commit; paired with Task 13–17)**

```bash
git add src/api-server/middleware/auth.ts
```

---

### Task 13: 404 vs 403 for cross-user access; tighten ownership checks

**Files:**
- Modify: `src/api-server/middleware/error-handler.ts` (no change needed; `NotFoundError` already returns 404)
- Modify: `src/api-server/routes/agents.ts` (return 404 not 403 when agent exists for another user)

- [ ] **Step 1: Update agent route handlers to return 404 on cross-user access**

In `src/api-server/routes/agents.ts`, every handler that fetches by id + asserts ownership should treat foreign-user agents as not-found (per spec error table — avoids leaking existence). Replace:

```typescript
const agent = await deps.db.agents.findById(req.params.id);
if (!agent) throw new NotFoundError();
assertAgentOwnedBy(agent, req.user!);
```

With:

```typescript
const agent = await deps.db.agents.findById(req.params.id);
if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
```

Apply this substitution in all 5 handlers: `r.get('/:id')`, `r.patch('/:id')`, `r.delete('/:id')`, `r.post('/:id/start')`, `r.post('/:id/stop')`.

Remove the now-unused `assertAgentOwnedBy` import from this file.

- [ ] **Step 2: Apply same pattern to other agent-scoped routers**

Files: `src/api-server/routes/activity.ts`, `src/api-server/routes/messages.ts`, `src/api-server/routes/stream.ts`. In each, find the `findById` + `assertAgentOwnedBy` pair and replace with the combined null-or-foreign check above.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: still has `server.ts` errors (Task 17), but route files are clean.

- [ ] **Step 4: Stage**

```bash
git add src/api-server/routes/agents.ts \
        src/api-server/routes/activity.ts \
        src/api-server/routes/messages.ts \
        src/api-server/routes/stream.ts
```

---

## Phase 3 — Wallet provisioner + endpoint

### Task 14: `WalletProvisioner` (live test)

**Files:**
- Create: `src/wallet/privy/wallet-provisioner.ts`
- Create: `src/wallet/privy/wallet-provisioner.live.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/wallet/privy/wallet-provisioner.live.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrismaClient } from '@prisma/client';
import { WalletProvisioner } from './wallet-provisioner';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { truncateAll } from '../../database/prisma-database/test-helpers';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!APP_ID || !APP_SECRET || !TEST_DB_URL)('WalletProvisioner (live)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL! } } });
  const privy = new PrivyClient(APP_ID!, APP_SECRET!);
  const userWallets = new PrismaUserWalletRepository(prisma);
  const users = new PrismaUserRepository(prisma);
  const provisioner = new WalletProvisioner(privy, userWallets);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('provisionPrimary creates a Privy wallet + inserts UserWallet', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    expect(uw.userId).toBe(u.id);
    expect(uw.privyWalletId).toBeTruthy();
    expect(uw.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(uw.isPrimary).toBe(true);
    console.log('[wallet-provisioner] created:', uw);
  });

  it('provisionPrimary is idempotent — returns existing primary', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const first = await provisioner.provisionPrimary(u.id);
    const second = await provisioner.provisionPrimary(u.id);
    expect(second.id).toBe(first.id);
    expect(second.privyWalletId).toBe(first.privyWalletId);
  });
});
```

- [ ] **Step 2: Run, watch fail (or skip)**

Run: `npm test -- wallet-provisioner.live`

- [ ] **Step 3: Implement**

```typescript
// src/wallet/privy/wallet-provisioner.ts
import { randomUUID } from 'node:crypto';
import type { PrivyClient } from '@privy-io/server-auth';
import type { UserWalletRepository } from '../../database/repositories/user-wallet-repository';
import type { UserWallet } from '../../database/types';

export class WalletProvisioner {
  constructor(
    private readonly privy: PrivyClient,
    private readonly userWallets: UserWalletRepository,
  ) {}

  async provisionPrimary(userId: string): Promise<UserWallet> {
    const existing = await this.userWallets.findPrimaryByUser(userId);
    if (existing) return existing;

    const created = await this.privy.walletApi.create({ chainType: 'ethereum' });

    const uw: UserWallet = {
      id: randomUUID(),
      userId,
      privyWalletId: created.id,
      walletAddress: created.address,
      isPrimary: true,
      createdAt: Date.now(),
    };
    await this.userWallets.insert(uw);
    return uw;
  }
}
```

- [ ] **Step 4: Run, watch pass (or stay skipped)**

Run: `npm test -- wallet-provisioner.live`

- [ ] **Step 5: Commit**

```bash
git add src/wallet/privy/wallet-provisioner.ts src/wallet/privy/wallet-provisioner.live.test.ts
git commit -m "feat(wallet): WalletProvisioner — create Privy wallet + insert UserWallet"
```

---

### Task 15: `users` route — GET /me, POST /me/wallets

**Files:**
- Create: `src/api-server/routes/users.ts`
- Modify: `src/api-server/openapi/schemas.ts` (add `UserSchema`, `UserWalletSchema`, `UsersMeResponseSchema`, `WalletResponseSchema`)

- [ ] **Step 1: Add OpenAPI schemas**

```typescript
// src/api-server/openapi/schemas.ts — append before any existing `registry.register*` calls
export const UserSchema = z.object({
  id: z.string(),
  privyDid: z.string(),
  email: z.string().nullable(),
  createdAt: z.number(),
}).openapi('User');

export const UserWalletSchema = z.object({
  id: z.string(),
  walletAddress: z.string(),
  isPrimary: z.boolean(),
  createdAt: z.number(),
}).openapi('UserWallet');

export const UsersMeResponseSchema = z.object({
  user: UserSchema,
  wallets: z.array(UserWalletSchema),
}).openapi('UsersMeResponse');
```

(Note: response wallets DO NOT include `privyWalletId` or `userId` — internal plumbing.)

- [ ] **Step 2: Write the router**

```typescript
// src/api-server/routes/users.ts
import { Router } from 'express';
import type { Database } from '../../database/database';
import type { WalletProvisioner } from '../../wallet/privy/wallet-provisioner';

interface Deps {
  db: Database;
  walletProvisioner: WalletProvisioner;
}

function publicWallet(uw: { id: string; walletAddress: string; isPrimary: boolean; createdAt: number }) {
  return {
    id: uw.id,
    walletAddress: uw.walletAddress,
    isPrimary: uw.isPrimary,
    createdAt: uw.createdAt,
  };
}

export function buildUsersRouter(deps: Deps): Router {
  const r = Router();

  r.get('/me', async (req, res, next) => {
    try {
      const user = req.user!;
      const wallets = await deps.db.userWallets.listByUser(user.id);
      res.json({ user, wallets: wallets.map(publicWallet) });
    } catch (err) { next(err); }
  });

  r.post('/me/wallets', async (req, res, next) => {
    try {
      const user = req.user!;
      const existing = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (existing) {
        res.status(200).json(publicWallet(existing));
        return;
      }
      try {
        const uw = await deps.walletProvisioner.provisionPrimary(user.id);
        res.status(201).json(publicWallet(uw));
      } catch (err) {
        // Privy API failure — surface as 502 per spec
        console.error('[users] wallet provisioning failed:', err);
        res.status(502).json({ error: 'wallet_provisioning_failed' });
      }
    } catch (err) { next(err); }
  });

  return r;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: still has `server.ts` errors (the new router isn't wired yet — Task 17).

- [ ] **Step 4: Stage**

```bash
git add src/api-server/routes/users.ts src/api-server/openapi/schemas.ts
```

---

## Phase 4 — Wallet module (built but not wired)

### Task 16: `PrivyServerWallet` (live test)

**Files:**
- Create: `src/wallet/privy/privy-server-wallet.ts`
- Create: `src/wallet/privy/privy-server-wallet.live.test.ts`

- [ ] **Step 1: Write failing test (read-only — no broadcast in this spec)**

```typescript
// src/wallet/privy/privy-server-wallet.live.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrismaClient } from '@prisma/client';
import { createPublicClient, http } from 'viem';
import { PrivyServerWallet } from './privy-server-wallet';
import { WalletProvisioner } from './wallet-provisioner';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { truncateAll } from '../../database/prisma-database/test-helpers';
import { UNICHAIN } from '../../constants';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const ALCHEMY = process.env.ALCHEMY_API_KEY;

describe.skipIf(!APP_ID || !APP_SECRET || !TEST_DB_URL || !ALCHEMY)('PrivyServerWallet (live, read-only)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL! } } });
  const privy = new PrivyClient(APP_ID!, APP_SECRET!);
  const users = new PrismaUserRepository(prisma);
  const userWallets = new PrismaUserWalletRepository(prisma);
  const provisioner = new WalletProvisioner(privy, userWallets);
  const publicClient = createPublicClient({
    chain: { id: UNICHAIN.chainId } as never,
    transport: http(`https://unichain-mainnet.g.alchemy.com/v2/${ALCHEMY}`),
  });

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('getAddress returns the UserWallet.walletAddress', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    const wallet = new PrivyServerWallet(privy, uw, publicClient);
    expect(wallet.getAddress()).toBe(uw.walletAddress);
  });

  it('getNativeBalance reads on-chain balance via viem (returns >= 0n)', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    const wallet = new PrivyServerWallet(privy, uw, publicClient);
    const balance = await wallet.getNativeBalance();
    expect(balance).toBeGreaterThanOrEqual(0n);
    console.log('[privy-server-wallet] balance:', balance.toString());
  });

  // No signAndSendTransaction test in this spec — would require a funded test wallet.
  // Broadcasts will be tested in the cutover spec where this wallet becomes the runtime wallet.
});
```

- [ ] **Step 2: Run, watch fail (or skip)**

Run: `npm test -- privy-server-wallet.live`

- [ ] **Step 3: Implement**

```typescript
// src/wallet/privy/privy-server-wallet.ts
import type { PrivyClient } from '@privy-io/server-auth';
import type { PublicClient } from 'viem';
import { erc20Abi } from 'viem';
import type { Wallet } from '../wallet';
import type { TxRequest, TransactionReceipt } from '../types';
import type { UserWallet } from '../../database/types';
import { UNICHAIN } from '../../constants';

export class PrivyServerWallet implements Wallet {
  constructor(
    private readonly privy: PrivyClient,
    private readonly userWallet: UserWallet,
    private readonly publicClient: PublicClient,
  ) {}

  getAddress(): `0x${string}` {
    return this.userWallet.walletAddress as `0x${string}`;
  }

  getNativeBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.getAddress() });
  }

  async getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint> {
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.getAddress()],
    });
  }

  async signAndSendTransaction(req: TxRequest): Promise<TransactionReceipt> {
    const result = await this.privy.walletApi.ethereum.sendTransaction({
      walletId: this.userWallet.privyWalletId,
      caip2: `eip155:${UNICHAIN.chainId}`,
      transaction: {
        to: req.to,
        ...(req.data ? { data: req.data } : {}),
        ...(req.value !== undefined ? { value: `0x${req.value.toString(16)}` } : {}),
        ...(req.gas !== undefined ? { gasLimit: `0x${req.gas.toString(16)}` } : {}),
      },
    });
    return await this.publicClient.waitForTransactionReceipt({
      hash: result.hash as `0x${string}`,
    });
  }
}
```

(SDK method names may differ from the snippet above; consult `@privy-io/server-auth` types in `node_modules` if compilation fails. The shape is: `walletId`, `caip2` chain reference, `transaction` body. Field names like `gasLimit` vs `gas` vary by SDK version — adjust to whatever the SDK exposes.)

- [ ] **Step 4: Run, watch pass (or stay skipped)**

Run: `npm test -- privy-server-wallet.live`

- [ ] **Step 5: Commit**

```bash
git add src/wallet/privy/privy-server-wallet.ts src/wallet/privy/privy-server-wallet.live.test.ts
git commit -m "feat(wallet): PrivyServerWallet impl + read-only live test"
```

---

### Task 17: `PrivyWalletFactory` (live test)

**Files:**
- Create: `src/wallet/privy/privy-wallet-factory.ts`
- Create: `src/wallet/privy/privy-wallet-factory.live.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/wallet/privy/privy-wallet-factory.live.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrismaClient } from '@prisma/client';
import { createPublicClient, http } from 'viem';
import { PrivyWalletFactory } from './privy-wallet-factory';
import { WalletProvisioner } from './wallet-provisioner';
import { PrivyServerWallet } from './privy-server-wallet';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { truncateAll } from '../../database/prisma-database/test-helpers';
import { UNICHAIN } from '../../constants';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const ALCHEMY = process.env.ALCHEMY_API_KEY;

describe.skipIf(!APP_ID || !APP_SECRET || !TEST_DB_URL || !ALCHEMY)('PrivyWalletFactory (live)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL! } } });
  const privy = new PrivyClient(APP_ID!, APP_SECRET!);
  const users = new PrismaUserRepository(prisma);
  const userWallets = new PrismaUserWalletRepository(prisma);
  const provisioner = new WalletProvisioner(privy, userWallets);
  const publicClient = createPublicClient({
    chain: { id: UNICHAIN.chainId } as never,
    transport: http(`https://unichain-mainnet.g.alchemy.com/v2/${ALCHEMY}`),
  });
  const factory = new PrivyWalletFactory(privy, publicClient);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('forUserWallet returns a PrivyServerWallet whose address matches the row', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    const wallet = factory.forUserWallet(uw);
    expect(wallet).toBeInstanceOf(PrivyServerWallet);
    expect(wallet.getAddress()).toBe(uw.walletAddress);
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `npm test -- privy-wallet-factory.live`

- [ ] **Step 3: Implement**

```typescript
// src/wallet/privy/privy-wallet-factory.ts
import type { PrivyClient } from '@privy-io/server-auth';
import type { PublicClient } from 'viem';
import type { Wallet } from '../wallet';
import type { UserWallet } from '../../database/types';
import { PrivyServerWallet } from './privy-server-wallet';

export class PrivyWalletFactory {
  constructor(
    private readonly privy: PrivyClient,
    private readonly publicClient: PublicClient,
  ) {}

  forUserWallet(uw: UserWallet): Wallet {
    return new PrivyServerWallet(this.privy, uw, this.publicClient);
  }
}
```

- [ ] **Step 4: Run, watch pass**

Run: `npm test -- privy-wallet-factory.live`

- [ ] **Step 5: Commit**

```bash
git add src/wallet/privy/privy-wallet-factory.ts src/wallet/privy/privy-wallet-factory.live.test.ts
git commit -m "feat(wallet): PrivyWalletFactory + live test"
```

---

### Task 18: Mark `WalletFactory.forAgent` as transitional (comment-only)

**Files:**
- Modify: `src/wallet/factory/wallet-factory.ts`

- [ ] **Step 1: Add a class-level docstring**

At the top of the `WalletFactory` class declaration (above `private readonly cache`):

```typescript
/**
 * Transitional: returns the env-key RealWallet for every agent regardless
 * of which user owns it. Per-user wallets via PrivyWalletFactory ship in
 * a follow-up cutover spec — the module exists and is tested under
 * `src/wallet/privy/` but is not wired into this factory yet.
 */
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: still has `server.ts` errors (Task 19).

- [ ] **Step 3: Stage**

```bash
git add src/wallet/factory/wallet-factory.ts
```

---

## Phase 5 — Bootstrap + final wiring

### Task 19: Wire `PrivyAuth`, `WalletProvisioner`, users router into `ApiServer`

**Files:**
- Modify: `src/api-server/server.ts`

- [ ] **Step 1: Update `ApiServerDeps` + constructor**

```typescript
// src/api-server/server.ts
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AgentActivityLog } from '../database/agent-activity-log';
import type { AgentRunner } from '../agent-runner/agent-runner';
import type { TickQueue } from '../agent-runner/tick-queue';
import type { Database } from '../database/database';
import type { PrivyAuth } from './auth/privy-auth';
import type { WalletProvisioner } from '../wallet/privy/wallet-provisioner';
import { buildAuthMiddleware } from './middleware/auth';
import { buildCorsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { buildAgentsRouter } from './routes/agents';
import { buildActivityRouter } from './routes/activity';
import { buildMessagesRouter } from './routes/messages';
import { buildStreamRouter } from './routes/stream';
import { buildUsersRouter } from './routes/users';
import { buildOpenApiRouter } from './routes/openapi';

export interface ApiServerDeps {
  db: Database;
  activityLog: AgentActivityLog;
  runner: AgentRunner;
  queue: TickQueue;
  privyAuth: PrivyAuth;
  walletProvisioner: WalletProvisioner;
  port: number;
  corsOrigins?: string;
}

export class ApiServer {
  private readonly app: Express;
  private server: Server | null = null;

  constructor(private readonly deps: ApiServerDeps) {
    this.app = express();
    this.app.use(buildCorsMiddleware(deps.corsOrigins));
    this.app.use(express.json({ limit: '1mb' }));

    // OpenAPI docs are public.
    this.app.use('/', buildOpenApiRouter());

    // All other routes require Privy auth.
    this.app.use(buildAuthMiddleware(deps.privyAuth, deps.db.users));

    this.app.use('/users', buildUsersRouter({ db: deps.db, walletProvisioner: deps.walletProvisioner }));
    this.app.use('/agents', buildAgentsRouter({ db: deps.db }));
    this.app.use('/agents/:id/activity', buildActivityRouter({ db: deps.db, activityLog: deps.activityLog }));
    this.app.use('/agents/:id/messages', buildMessagesRouter({ db: deps.db, activityLog: deps.activityLog, runner: deps.runner, queue: deps.queue }));
    this.app.use('/agents/:id/stream', buildStreamRouter({ db: deps.db, activityLog: deps.activityLog }));

    this.app.use(errorHandler);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.deps.port, () => {
        console.log(`[api-server] listening on http://localhost:${this.deps.port} (docs: /docs)`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getApp(): Express {
    return this.app;
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: errors in `src/index.ts` (it doesn't yet provide the new deps — Task 20). All other files clean.

- [ ] **Step 3: Stage**

```bash
git add src/api-server/server.ts
```

---

### Task 20: `src/index.ts` — construct Privy client + wire ApiServer

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports + bootstrap logic**

In `src/index.ts`, add these imports near the top (alongside the existing `import { ApiServer } from './api-server/server';`):

```typescript
import { PrivyClient } from '@privy-io/server-auth';
import { PrivyAuth } from './api-server/auth/privy-auth';
import { WalletProvisioner } from './wallet/privy/wallet-provisioner';
```

In `main()`, after `db` is constructed and BEFORE the `if (runServer)` block, add:

```typescript
let privyAuth: PrivyAuth | null = null;
let walletProvisioner: WalletProvisioner | null = null;

if (env.MODE === 'server' || env.MODE === 'both') {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    console.error('[bootstrap] PRIVY_APP_ID + PRIVY_APP_SECRET are required when MODE includes server');
    process.exit(1);
  }
  const privy = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  privyAuth = new PrivyAuth(privy);
  walletProvisioner = new WalletProvisioner(privy, db.userWallets);
  console.log('[bootstrap] Privy auth + wallet provisioner initialized');
}
```

Update the `if (runServer)` block to pass the new deps:

```typescript
if (runServer) {
  api = new ApiServer({
    db,
    activityLog,
    runner,
    queue,
    privyAuth: privyAuth!,
    walletProvisioner: walletProvisioner!,
    port: env.PORT,
    ...(env.API_CORS_ORIGINS ? { corsOrigins: env.API_CORS_ORIGINS } : {}),
  });
  await api.start();
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Smoke test — looper-only**

```bash
MODE=looper npm start
```

Expected: bootstrap logs, no `[bootstrap] Privy auth ...` line (skipped under MODE=looper). Looper ticks. Ctrl-C.

- [ ] **Step 4: Smoke test — server (with Privy creds)**

If `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are set in `.env`:
```bash
MODE=server npm start
```
Expected: `[bootstrap] Privy auth + wallet provisioner initialized` log line, then `[api-server] listening on http://localhost:3000`. Ctrl-C.

If creds are missing, expect: `[bootstrap] PRIVY_APP_ID + PRIVY_APP_SECRET are required ...` and exit 1.

- [ ] **Step 5: Commit (final batch — Tasks 12, 13, 15, 18, 19, 20)**

```bash
git add -A
git commit -m "feat(api): wire Privy auth + users router + wallet provisioner into ApiServer

- buildAuthMiddleware verifies Privy JWT, upserts User on first DID seen.
- 404 instead of 403 for cross-user agent access (no existence leak).
- New /users/me + POST /users/me/wallets endpoints.
- WalletFactory.forAgent stays env-key (transitional) — Privy cutover follows.
- src/index.ts constructs PrivyClient when MODE includes server."
```

---

### Task 21: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the env block, append Privy lines**

In `CLAUDE.md`, locate the `## Env` section and append at the end of the `\`\`\`` block:

```
# Privy (required when MODE=server or MODE=both)
PRIVY_APP_ID=
PRIVY_APP_SECRET=
```

- [ ] **Step 2: Add a new architectural section after `### Database = storage-agnostic facade, Prisma + Postgres`**

```markdown
### Users + auth

`User` rows are keyed by Privy DID; `UserWallet` is 1:N to `User` with `isPrimary` flagging the default wallet. v1 invariant: every User has exactly one `UserWallet`.

API auth middleware verifies the `Authorization: Bearer <privy-jwt>` header via `@privy-io/server-auth`, then upserts the `User` row by DID and attaches it to `req.user`. First-time users hit `POST /users/me/wallets` to provision their primary Privy server wallet.

`Agent.userId` is required and FK-cascades to `User`. Cross-user agent access returns 404 (not 403) to avoid leaking agent existence.

`WalletFactory.forAgent` returns the operator-funded env-key `RealWallet` regardless of which user owns the agent. Per-user Privy wallets ship in a follow-up cutover spec; the `src/wallet/privy/` module is fully built and live-tested in preparation. `MODE=looper` runs without Privy credentials; `MODE=server`/`MODE=both` require `PRIVY_APP_ID` + `PRIVY_APP_SECRET`.
```

- [ ] **Step 3: Stage + commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): document Privy users/wallets architecture + env"
```

---

## End-to-end verification

After Task 21:

```bash
# 1. Reset DB and re-seed
npm run db:reset

# 2. Verify the User+Agent join
docker exec agent-loop-postgres psql -U postgres -d agent_loop -c '
  SELECT u.id AS user_id, u."privyDid", a.id AS agent_id, a.name FROM "User" u JOIN "Agent" a ON a."userId" = u.id;'
# Expected: 1 row joining the dev user with the seed agent.

# 3. Run the full test suite
npm test 2>&1 | tail -10
# Expected: 85+/86+ pass — same baseline as before this work.
# (Privy live tests skip when PRIVY_APP_*  unset; that's fine.)

# 4. Smoke MODE=looper (no Privy needed)
MODE=looper npm start
# Expected: looper boots, ticks, no auth involved. Ctrl-C.

# 5. Smoke MODE=server (requires Privy creds; fails fast if missing)
MODE=server npm start
# Expected (with creds): bootstrap log + /api-server listening. Ctrl-C.
# Expected (without creds): "PRIVY_APP_ID + PRIVY_APP_SECRET are required" + exit 1.
```

---

## Task summary

| # | Phase | Task | Touches |
|---|-------|------|---------|
| 1 | 0 | Domain types: User, UserWallet, AgentConfig.userId | `types.ts` |
| 2 | 0 | Prisma schema + migration | `schema.prisma`, migration |
| 3 | 0 | Repository interfaces | 2 new files |
| 4 | 0 | Database / PrismaDatabase wiring | `database.ts`, composer |
| 5 | 0 | Mappers (user, userWallet, agent.userId) | `mappers.ts` |
| 6 | 0 | PrismaUserRepository (TDD) | repo + tests |
| 7 | 0 | PrismaUserWalletRepository (TDD) | repo + tests |
| 8 | 0 | Wire AgentConfig.userId everywhere | route, schemas, ~6 fixtures |
| 9 | 1 | Seed script creates dev User first | `prisma/seed.ts`, `seed-uni-ma-trader.ts` |
| 10 | 2 | Install @privy-io/server-auth + env | `package.json`, `env.ts`, `.env.example` |
| 11 | 2 | PrivyAuth wrapper (TDD) | new file + test |
| 12 | 2 | buildAuthMiddleware + assertAgentOwnedBy | `auth.ts` |
| 13 | 2 | 404 instead of 403 on cross-user access | 4 route files |
| 14 | 3 | WalletProvisioner (TDD) | new file + test |
| 15 | 3 | users router + OpenAPI schemas | new file, schemas |
| 16 | 4 | PrivyServerWallet (TDD, read-only) | new file + test |
| 17 | 4 | PrivyWalletFactory (TDD) | new file + test |
| 18 | 4 | Mark WalletFactory.forAgent transitional | comment-only |
| 19 | 5 | ApiServer takes new deps | `server.ts` |
| 20 | 5 | src/index.ts constructs PrivyClient | `index.ts` |
| 21 | 5 | CLAUDE.md updates | docs |
