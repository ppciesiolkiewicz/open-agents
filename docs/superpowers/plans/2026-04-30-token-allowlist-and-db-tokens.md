# Token Allowlist + DB-Backed Token Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded `TOKENS` constant with a DB-backed token catalog, give each agent an allowlist of trade-able tokens, fix LLM-decimals bug at swap boundary, add token-info and decimal-utility AI tools.

**Architecture:** New `TokenRepository` exposes the existing `Token` Prisma table to AI tools and the API. `Agent.allowedTokens: String[]` (lowercased Unichain addresses) gates the swap tool. Swap/quote tools accept human-decimal inputs (`"0.01"`) and resolve token decimals server-side. Two new constants `USDC_ON_UNICHAIN` / `UNI_ON_UNICHAIN` replace the old TOKENS map for legitimate hardcodes (treasury, stable detection, tests). New `GET /tokens` (paginated catalog) and `GET /agents/:id/allowed-tokens` endpoints. CoinGecko coin-list enrichment populates `Token.coingeckoId` during seed.

**Tech Stack:** TypeScript, Prisma + Postgres, Express, zod + zod-to-openapi, viem (formatUnits/parseUnits), Vitest, Langchain tool wrappers.

**Spec:** [docs/superpowers/specs/2026-04-30-token-allowlist-and-db-tokens.md](../specs/2026-04-30-token-allowlist-and-db-tokens.md)

---

## File Map

**Create:**
- `prisma/migrations/<timestamp>_add_agent_allowed_tokens_and_token_coingecko_id/migration.sql`
- `src/database/repositories/token-repository.ts` — repo interface
- `src/database/prisma-database/prisma-token-repository.ts` — Prisma impl
- `src/database/prisma-database/prisma-token-repository.live.test.ts` — live test
- `src/ai-tools/tokens/find-tokens-by-symbol-tool.ts`
- `src/ai-tools/tokens/get-token-by-address-tool.ts`
- `src/ai-tools/tokens/list-allowed-tokens-tool.ts`
- `src/ai-tools/utility/format-token-amount-tool.ts`
- `src/ai-tools/utility/parse-token-amount-tool.ts`
- `src/ai-tools/utility/format-token-amount-tool.test.ts`
- `src/ai-tools/utility/parse-token-amount-tool.test.ts`
- `src/api-server/routes/tokens.ts` — GET /tokens
- `src/api-server/routes/tokens.live.test.ts`

**Modify:**
- `prisma/schema.prisma` — add `Agent.allowedTokens` + `Token.coingeckoId`
- `prisma/seed-tokens.ts` — CoinGecko coin-list enrichment
- `scripts/lib/seed-uni-ma-trader.ts` — add `allowedTokens` to seed agent + drop `TOKENS` import
- `src/database/types.ts` — add `Token` domain type, extend `AgentConfig` with `allowedTokens`
- `src/database/database.ts` — add `tokens: TokenRepository` to facade
- `src/database/prisma-database/prisma-database.ts` — wire `PrismaTokenRepository`
- `src/database/prisma-database/mappers.ts` — map `allowedTokens` and add `tokenRowToDomain`
- `src/database/prisma-database/prisma-agent-repository.ts` — persist `allowedTokens`
- `src/constants/tokens.ts` — rewrite (delete TOKENS, add USDC_ON_UNICHAIN + UNI_ON_UNICHAIN)
- `src/constants/index.ts` — re-exports
- `src/api-server/routes/treasury.ts` — TOKENS → USDC_ON_UNICHAIN
- `src/treasury/treasury-wallet.ts` — TOKENS → USDC_ON_UNICHAIN
- `src/treasury/treasury-funds-watcher.ts` — TOKENS → USDC_ON_UNICHAIN
- `src/balance/balance-service.ts` — TOKENS → USDC_ON_UNICHAIN
- `src/uniswap/position-tracker.ts` — TOKENS → USDC_ON_UNICHAIN
- `src/uniswap/pool-key-builder.test.ts` — TOKENS → constants
- `src/uniswap/position-tracker.test.ts` — TOKENS → constants
- `src/uniswap/swap-quoter.live.test.ts` — TOKENS → constants
- `src/uniswap/pool-state-reader.live.test.ts` — TOKENS → constants
- `src/uniswap/permit2-allowance.live.test.ts` — TOKENS → constants
- `src/uniswap/v4-actions.test.ts` — TOKENS → constants
- `src/wallet/dry-run/dry-run-wallet.live.test.ts` — TOKENS → constants
- `src/wallet/real/real-wallet.live.test.ts` — TOKENS → constants
- `src/ai-tools/uniswap/uniswap-swap-tool.ts` — address-based input + allowlist gate + DB lookup
- `src/ai-tools/uniswap/uniswap-quote-tool.ts` — address-based input + DB lookup
- `src/ai-tools/providers/coingecko-price-tool.ts` — coingeckoId | tokenAddress input + DB lookup
- `src/ai-tools/wallet/wallet-balance-tools.ts` — enriched response shape
- `src/ai-tools/tool-registry.ts` — register new tools
- `src/ai-tools/tool-registry.test.ts` — update expected tool list
- `src/ai-tools/tool-registry.live.test.ts` — update fixtures (TOKENS → constants)
- `src/api-server/routes/agents.ts` — `allowedTokens` validation in POST/PATCH + new GET /:id/allowed-tokens
- `src/api-server/openapi/schemas.ts` — Token schemas + extend agent body schemas
- `src/api-server/openapi/spec-builder.ts` — register new paths + update agent paths
- `src/api-server/server.ts` — mount tokens router

---

## Task 1: Schema migration — `Agent.allowedTokens` + `Token.coingeckoId`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_agent_allowed_tokens_and_token_coingecko_id/migration.sql` (Prisma generates)

- [ ] **Step 1: Edit `prisma/schema.prisma` — Agent model**

In `model Agent`, add after existing fields (after `userId`):

```prisma
  allowedTokens       String[]  @default([])
```

- [ ] **Step 2: Edit `prisma/schema.prisma` — Token model**

In `model Token`, add after `logoUri`:

```prisma
  coingeckoId String?
```

- [ ] **Step 3: Generate migration**

Run: `npm run db:up && npx prisma migrate dev --name add_agent_allowed_tokens_and_token_coingecko_id`
Expected: new directory under `prisma/migrations/` containing `migration.sql` with `ALTER TABLE "Agent" ADD COLUMN "allowedTokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]` and `ALTER TABLE "Token" ADD COLUMN "coingeckoId" TEXT`.

- [ ] **Step 4: Verify Prisma client regenerated**

Run: `npx prisma generate`
Expected: completes without error. `node_modules/.prisma/client` contains updated types (`Token.coingeckoId: string | null`, `Agent.allowedTokens: string[]`).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add Agent.allowedTokens and Token.coingeckoId"
```

---

## Task 2: Domain types + mapper for `Token` and `allowedTokens`

**Files:**
- Modify: `src/database/types.ts`
- Modify: `src/database/prisma-database/mappers.ts`

- [ ] **Step 1: Edit `src/database/types.ts` — extend `AgentConfig`**

Add `allowedTokens: string[];` to the `AgentConfig` interface (after `dryRunSeedBalances`):

```ts
export interface AgentConfig {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>;
  allowedTokens: string[];          // lowercased Unichain addresses; [] = no trading
  riskLimits: {
    maxTradeUSD: number;
    maxSlippageBps: number;
    [k: string]: unknown;
  };
  createdAt: number;
  running?: boolean;
  intervalMs?: number;
  lastTickAt?: number | null;
}
```

- [ ] **Step 2: Add `Token` domain type to `src/database/types.ts`**

Append at end of file:

```ts
export interface Token {
  id: number;
  chainId: number;
  chain: string;
  address: string;          // lowercased
  symbol: string;
  name: string;
  decimals: number;
  logoUri: string | null;
  coingeckoId: string | null;
}
```

- [ ] **Step 3: Edit `src/database/prisma-database/mappers.ts` — extend `agentRowToDomain`**

Replace the function with:

```ts
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
    allowedTokens: row.allowedTokens,
    riskLimits: row.riskLimits as AgentConfig['riskLimits'],
    createdAt: numReq(row.createdAt),
    running: row.running ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    lastTickAt: num(row.lastTickAt),
  };
}
```

- [ ] **Step 4: Add `tokenRowToDomain` to mappers.ts**

At top of file, add `Token as PrismaToken` to the prisma imports:

```ts
import type {
  Agent as PrismaAgent,
  Transaction as PrismaTransaction,
  Position as PrismaPosition,
  AgentMemory as PrismaAgentMemory,
  MemoryEntry as PrismaMemoryEntry,
  ActivityEvent as PrismaActivityEvent,
  User as PrismaUser,
  UserWallet as PrismaUserWallet,
  Token as PrismaToken,
} from '@prisma/client';
```

Add `Token` to domain-type imports:

```ts
import type {
  AgentConfig,
  Transaction,
  Position,
  AgentMemory,
  MemoryEntry,
  TokenAmount,
  AgentActivityLogEntry,
  User,
  UserWallet,
  Token,
} from '../types';
```

Append function at end of file:

```ts
export function tokenRowToDomain(row: PrismaToken): Token {
  return {
    id: row.id,
    chainId: row.chainId,
    chain: row.chain,
    address: row.address.toLowerCase(),
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    logoUri: row.logoUri,
    coingeckoId: row.coingeckoId,
  };
}
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck` (or `npx tsc --noEmit`)
Expected: passes. `prisma-agent-repository.ts.upsert` will fail until Task 3 because `agentDomainToRow` doesn't exist — but `agentRowToDomain` should compile against the new types, and the only direct upsert site reads/writes `agent` records inline, so the build still succeeds. If typecheck fails because of an `agent.allowedTokens` access, jump to Task 3 first then return.

> Note: If typecheck fails on `prisma-agent-repository.ts` because `upsert` does not pass `allowedTokens`, that is expected — fixed in Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/database/types.ts src/database/prisma-database/mappers.ts
git commit -m "feat(db): extend AgentConfig with allowedTokens, add Token domain type"
```

---

## Task 3: Persist `allowedTokens` through `PrismaAgentRepository`

**Files:**
- Modify: `src/database/prisma-database/prisma-agent-repository.ts`

- [ ] **Step 1: Read the file**

Run: `cat src/database/prisma-database/prisma-agent-repository.ts`
Locate the `upsert` method.

- [ ] **Step 2: Update `upsert` to write `allowedTokens`**

In both the `create` and `update` payloads of the upsert call, add `allowedTokens: agent.allowedTokens`. Example:

```ts
async upsert(agent: AgentConfig): Promise<void> {
  await this.prisma.agent.upsert({
    where: { id: agent.id },
    create: {
      id: agent.id,
      userId: agent.userId,
      name: agent.name,
      prompt: agent.prompt,
      dryRun: agent.dryRun,
      dryRunSeedBalances: (agent.dryRunSeedBalances ?? null) as Prisma.InputJsonValue | null,
      allowedTokens: agent.allowedTokens,
      riskLimits: agent.riskLimits as Prisma.InputJsonValue,
      createdAt: BigInt(agent.createdAt),
      running: agent.running ?? null,
      intervalMs: agent.intervalMs ?? null,
      lastTickAt: agent.lastTickAt === null || agent.lastTickAt === undefined
        ? null
        : BigInt(agent.lastTickAt),
    },
    update: {
      name: agent.name,
      prompt: agent.prompt,
      dryRun: agent.dryRun,
      dryRunSeedBalances: (agent.dryRunSeedBalances ?? null) as Prisma.InputJsonValue | null,
      allowedTokens: agent.allowedTokens,
      riskLimits: agent.riskLimits as Prisma.InputJsonValue,
      running: agent.running ?? null,
      intervalMs: agent.intervalMs ?? null,
      lastTickAt: agent.lastTickAt === null || agent.lastTickAt === undefined
        ? null
        : BigInt(agent.lastTickAt),
    },
  });
}
```

(Adjust to match existing style of the file — keep its existing code paths intact, only insert the two `allowedTokens` lines and any matching imports.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/database/prisma-database/prisma-agent-repository.ts
git commit -m "feat(db): persist Agent.allowedTokens via PrismaAgentRepository"
```

---

## Task 4: `TokenRepository` interface

**Files:**
- Create: `src/database/repositories/token-repository.ts`

- [ ] **Step 1: Create the interface file**

Write `src/database/repositories/token-repository.ts`:

```ts
import type { Token } from '../types';

export interface TokenListPage {
  tokens: Token[];
  nextCursor: string | null;
}

export interface TokenRepository {
  findByAddress(address: string, chainId: number): Promise<Token | null>;
  findManyByAddresses(addresses: string[], chainId: number): Promise<Token[]>;
  findBySymbol(symbol: string, chainId: number): Promise<Token[]>;
  list(opts: {
    chainId?: number;
    symbol?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<TokenListPage>;
}
```

- [ ] **Step 2: Add to `Database` facade**

Edit `src/database/database.ts`. Add import + facade member:

```ts
import type { TokenRepository } from './repositories/token-repository';
// ...
export interface Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;
  readonly users: UserRepository;
  readonly userWallets: UserWalletRepository;
  readonly zeroGPurchases: ZeroGPurchaseRepository;
  readonly tokens: TokenRepository;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: fails — `PrismaDatabase` does not yet implement `tokens`. Will be fixed in Task 5.

- [ ] **Step 4: Commit (leave typecheck broken — fixed in Task 5)**

```bash
git add src/database/repositories/token-repository.ts src/database/database.ts
git commit -m "feat(db): add TokenRepository interface to Database facade"
```

---

## Task 5: `PrismaTokenRepository` implementation (TDD with live test)

**Files:**
- Create: `src/database/prisma-database/prisma-token-repository.ts`
- Create: `src/database/prisma-database/prisma-token-repository.live.test.ts`
- Modify: `src/database/prisma-database/prisma-database.ts`

- [ ] **Step 1: Write the failing live test**

Create `src/database/prisma-database/prisma-token-repository.live.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaTokenRepository } from './prisma-token-repository';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../../constants';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for live DB tests');
}

const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
const repo = new PrismaTokenRepository(prisma);

const UNICHAIN = 130;

beforeAll(async () => {
  await prisma.token.deleteMany({ where: { chainId: UNICHAIN } });
  await prisma.token.createMany({
    data: [
      {
        chainId: UNICHAIN,
        chain: 'unichain',
        address: USDC_ON_UNICHAIN.address.toLowerCase(),
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        coingeckoId: 'usd-coin',
      },
      {
        chainId: UNICHAIN,
        chain: 'unichain',
        address: UNI_ON_UNICHAIN.address.toLowerCase(),
        symbol: 'UNI',
        name: 'Uniswap',
        decimals: 18,
        coingeckoId: 'uniswap',
      },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PrismaTokenRepository (live)', () => {
  it('findByAddress lowercases input and returns token', async () => {
    const t = await repo.findByAddress(USDC_ON_UNICHAIN.address.toUpperCase(), UNICHAIN);
    expect(t).not.toBeNull();
    expect(t!.symbol).toBe('USDC');
    expect(t!.address).toBe(USDC_ON_UNICHAIN.address.toLowerCase());
    expect(t!.coingeckoId).toBe('usd-coin');
    console.log('findByAddress result:', t);
  });

  it('findByAddress returns null for unknown address', async () => {
    const t = await repo.findByAddress('0x0000000000000000000000000000000000000000', UNICHAIN);
    expect(t).toBeNull();
  });

  it('findManyByAddresses returns all known, drops unknown', async () => {
    const result = await repo.findManyByAddresses(
      [USDC_ON_UNICHAIN.address, UNI_ON_UNICHAIN.address, '0xDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEF'],
      UNICHAIN,
    );
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.symbol).sort()).toEqual(['UNI', 'USDC']);
  });

  it('findBySymbol returns all matches', async () => {
    const result = await repo.findBySymbol('USDC', UNICHAIN);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((t) => t.symbol === 'USDC')).toBe(true);
  });

  it('list paginates with cursor', async () => {
    const page1 = await repo.list({ chainId: UNICHAIN, limit: 1 });
    expect(page1.tokens).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await repo.list({ chainId: UNICHAIN, limit: 1, cursor: page1.nextCursor! });
    expect(page2.tokens).toHaveLength(1);
    expect(page2.tokens[0].id).not.toBe(page1.tokens[0].id);
  });

  it('list with search matches symbol and name (case-insensitive)', async () => {
    const r = await repo.list({ chainId: UNICHAIN, search: 'usd', limit: 50 });
    expect(r.tokens.some((t) => t.symbol === 'USDC')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- prisma-token-repository.live`
Expected: FAIL — file `prisma-token-repository.ts` does not exist.

- [ ] **Step 3: Implement `PrismaTokenRepository`**

Create `src/database/prisma-database/prisma-token-repository.ts`:

```ts
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Token } from '../types';
import type { TokenRepository, TokenListPage } from '../repositories/token-repository';
import { tokenRowToDomain } from './mappers';

export class PrismaTokenRepository implements TokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByAddress(address: string, chainId: number): Promise<Token | null> {
    const row = await this.prisma.token.findUnique({
      where: { address_chainId: { address: address.toLowerCase(), chainId } },
    });
    return row ? tokenRowToDomain(row) : null;
  }

  async findManyByAddresses(addresses: string[], chainId: number): Promise<Token[]> {
    if (addresses.length === 0) return [];
    const lowered = addresses.map((a) => a.toLowerCase());
    const rows = await this.prisma.token.findMany({
      where: { chainId, address: { in: lowered } },
    });
    return rows.map(tokenRowToDomain);
  }

  async findBySymbol(symbol: string, chainId: number): Promise<Token[]> {
    const rows = await this.prisma.token.findMany({
      where: { chainId, symbol },
    });
    return rows.map(tokenRowToDomain);
  }

  async list(opts: {
    chainId?: number;
    symbol?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<TokenListPage> {
    const limit = Math.min(opts.limit, 500);
    const where: Prisma.TokenWhereInput = {};
    if (opts.chainId !== undefined) where.chainId = opts.chainId;
    if (opts.symbol) where.symbol = opts.symbol;
    if (opts.search) {
      where.OR = [
        { symbol: { contains: opts.search, mode: 'insensitive' } },
        { name: { contains: opts.search, mode: 'insensitive' } },
      ];
    }

    const cursorId = opts.cursor ? Number(Buffer.from(opts.cursor, 'base64').toString('utf8')) : undefined;
    if (cursorId !== undefined && Number.isNaN(cursorId)) {
      throw new Error(`invalid cursor: ${opts.cursor}`);
    }

    const rows = await this.prisma.token.findMany({
      where,
      take: limit + 1,
      orderBy: { id: 'asc' },
      ...(cursorId !== undefined ? { skip: 1, cursor: { id: cursorId } } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? Buffer.from(String(page[page.length - 1].id), 'utf8').toString('base64')
      : null;

    return {
      tokens: page.map(tokenRowToDomain),
      nextCursor,
    };
  }
}
```

- [ ] **Step 4: Wire into `PrismaDatabase`**

Edit `src/database/prisma-database/prisma-database.ts`. Add import + member:

```ts
import { PrismaTokenRepository } from './prisma-token-repository';

// inside the class constructor (mirror existing repo wiring):
this.tokens = new PrismaTokenRepository(this.prisma);
```

Add `readonly tokens: TokenRepository;` to the class field list. Reference existing repo wiring for the exact pattern.

- [ ] **Step 5: Run test (expect pass)**

Run: `npm test -- prisma-token-repository.live`
Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/database/prisma-database/prisma-token-repository.ts \
        src/database/prisma-database/prisma-token-repository.live.test.ts \
        src/database/prisma-database/prisma-database.ts
git commit -m "feat(db): add PrismaTokenRepository with live tests"
```

---

## Task 6: Rewrite `src/constants/tokens.ts` — split into per-token constants

**Files:**
- Modify: `src/constants/tokens.ts`
- Modify: `src/constants/index.ts` (verify re-exports)

- [ ] **Step 1: Rewrite `src/constants/tokens.ts`**

Replace entire file with:

```ts
export interface TokenInfo {
  address: `0x${string}`;
  decimals: number;
  symbol: string;
  coingeckoId: string;
}

export const USDC_ON_UNICHAIN = {
  address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  decimals: 6,
  symbol: 'USDC',
  coingeckoId: 'usd-coin',
} as const satisfies TokenInfo;

export const UNI_ON_UNICHAIN = {
  address: '0x8f187aA05619a017077f5308904739877ce9eA21',
  decimals: 18,
  symbol: 'UNI',
  coingeckoId: 'uniswap',
} as const satisfies TokenInfo;

export const ZEROG_NATIVE_TOKEN = {
  symbol: 'OG',
  decimals: 18,
  coingeckoId: 'zero-gravity',
} as const;

export const USDCE_ON_ZEROG = {
  address: '0x1f3aa82227281ca364bfb3d253b0f1af1da6473e' as `0x${string}`,
  decimals: 6,
  symbol: 'USDC.e',
  coingeckoId: 'usd-coin',
} as const;

export const W0G_ON_ZEROG = {
  address: '0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c' as `0x${string}`,
  decimals: 18,
  symbol: 'W0G',
} as const;
```

`TOKENS` and `TokenSymbol` are deleted (intentional — drives compile errors at every callsite that needs migration).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: many errors referencing `TOKENS` and `TokenSymbol`. These drive Tasks 7–13. Do NOT fix them yet — keep the file in this state.

- [ ] **Step 3: Commit**

```bash
git add src/constants/tokens.ts src/constants/index.ts
git commit -m "refactor(constants): split TOKENS into USDC_ON_UNICHAIN + UNI_ON_UNICHAIN"
```

---

## Task 7: Migrate non-AI infrastructure callsites (treasury, balance, position-tracker)

**Files:**
- Modify: `src/api-server/routes/treasury.ts`
- Modify: `src/treasury/treasury-wallet.ts`
- Modify: `src/treasury/treasury-funds-watcher.ts`
- Modify: `src/balance/balance-service.ts`
- Modify: `src/uniswap/position-tracker.ts`

- [ ] **Step 1: Update `src/api-server/routes/treasury.ts`**

Change import:
```ts
import { USDC_ON_UNICHAIN } from '../../constants/index.js';
```
Replace every `TOKENS.USDC` with `USDC_ON_UNICHAIN`. Verify lines around 43, 55, 64, 65 (the four current usage sites — run `grep -n TOKENS src/api-server/routes/treasury.ts` to confirm zero remaining).

- [ ] **Step 2: Update `src/treasury/treasury-wallet.ts`**

Change import to `USDC_ON_UNICHAIN`. Replace `TOKENS.USDC` → `USDC_ON_UNICHAIN`.

- [ ] **Step 3: Update `src/treasury/treasury-funds-watcher.ts`**

Same — `TOKENS.USDC` → `USDC_ON_UNICHAIN`.

- [ ] **Step 4: Update `src/balance/balance-service.ts`**

Replace `import { TOKENS, ... }` with `import { USDC_ON_UNICHAIN, ... }`. Update the two existing usages.

- [ ] **Step 5: Update `src/uniswap/position-tracker.ts`**

Change import:
```ts
import { USDC_ON_UNICHAIN } from '../constants';
```
Replace `STABLE_TOKEN_ADDRESSES` initialization:
```ts
const STABLE_TOKEN_ADDRESSES = new Set<string>([USDC_ON_UNICHAIN.address.toLowerCase()]);
```

- [ ] **Step 6: Verify infrastructure code typechecks**

Run: `npx tsc --noEmit 2>&1 | grep -E "(treasury|balance|position-tracker)" | head -20`
Expected: no errors mentioning these files. (AI-tools and tests will still error — addressed in later tasks.)

- [ ] **Step 7: Commit**

```bash
git add src/api-server/routes/treasury.ts \
        src/treasury/treasury-wallet.ts \
        src/treasury/treasury-funds-watcher.ts \
        src/balance/balance-service.ts \
        src/uniswap/position-tracker.ts
git commit -m "refactor: migrate infrastructure callsites to USDC_ON_UNICHAIN"
```

---

## Task 8: Migrate test fixtures

**Files:**
- Modify: `src/uniswap/pool-key-builder.test.ts`
- Modify: `src/uniswap/position-tracker.test.ts`
- Modify: `src/uniswap/swap-quoter.live.test.ts`
- Modify: `src/uniswap/pool-state-reader.live.test.ts`
- Modify: `src/uniswap/permit2-allowance.live.test.ts`
- Modify: `src/uniswap/v4-actions.test.ts`
- Modify: `src/wallet/dry-run/dry-run-wallet.live.test.ts`
- Modify: `src/wallet/real/real-wallet.live.test.ts`

- [ ] **Step 1: Replace TOKENS imports + usages in all 8 test files**

For each file:
- Replace `import { TOKENS } from '../constants'` → `import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../constants'`
- Replace every `TOKENS.USDC` → `USDC_ON_UNICHAIN`
- Replace every `TOKENS.UNI` → `UNI_ON_UNICHAIN`
- For object key form `[TOKENS.USDC.address]`, becomes `[USDC_ON_UNICHAIN.address]` (same shape)

Sanity grep after edits:
```bash
grep -rn "TOKENS\b" src/ --include="*.ts"
```
Expected: no matches in any test file. (AI-tools may still match — handled in Task 10.)

- [ ] **Step 2: Run unit tests for these files**

Run:
```bash
npm test -- pool-key-builder position-tracker.test v4-actions
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/uniswap/pool-key-builder.test.ts \
        src/uniswap/position-tracker.test.ts \
        src/uniswap/swap-quoter.live.test.ts \
        src/uniswap/pool-state-reader.live.test.ts \
        src/uniswap/permit2-allowance.live.test.ts \
        src/uniswap/v4-actions.test.ts \
        src/wallet/dry-run/dry-run-wallet.live.test.ts \
        src/wallet/real/real-wallet.live.test.ts
git commit -m "test: migrate fixtures to USDC_ON_UNICHAIN/UNI_ON_UNICHAIN"
```

---

## Task 9: Update seed agent builder + seed.ts

**Files:**
- Modify: `scripts/lib/seed-uni-ma-trader.ts`

- [ ] **Step 1: Replace TOKENS import**

Change top of file:
```ts
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../../src/constants';
```

- [ ] **Step 2: Update PROMPT string**

Replace the two `${TOKENS.USDC.address}` and `${TOKENS.UNI.address}` interpolations:
```ts
8. Call getTokenBalance for tokenAddress="${USDC_ON_UNICHAIN.address}" and tokenAddress="${UNI_ON_UNICHAIN.address}" to know your holdings.
```

Also update the swap calls in the prompt to use addresses (since swap tool now takes addresses):
```ts
   - GOLDEN_CROSS AND USDC raw balance > 0: call executeUniswapSwapExactIn with tokenInAddress="${USDC_ON_UNICHAIN.address}", tokenOutAddress="${UNI_ON_UNICHAIN.address}", amountIn=<USDC balance / 4 in human decimal, e.g. "0.25">, slippageBps=200.
   - DEATH_CROSS AND UNI raw balance > 0: call executeUniswapSwapExactIn with tokenInAddress="${UNI_ON_UNICHAIN.address}", tokenOutAddress="${USDC_ON_UNICHAIN.address}", amountIn=<full UNI balance in human decimal>, slippageBps=200.
```

Replace the closing line `Always pass amountIn as a string of base-units (no decimal scaling). USDC has 6 decimals, UNI has 18.` with:
```
Always pass amountIn as a human-decimal string (e.g. "0.5" for half a USDC, "1.234" for 1.234 UNI). The swap and quote tools resolve token decimals from the catalog automatically.
```

- [ ] **Step 3: Update `dryRunSeedBalances` keys**

Replace:
```ts
dryRunSeedBalances: {
  native: '100000000000000000',
  [USDC_ON_UNICHAIN.address]: '1000000000',
  [UNI_ON_UNICHAIN.address]: '0',
},
```

- [ ] **Step 4: Add `allowedTokens` to seed config**

In the returned `AgentConfig`, add:
```ts
allowedTokens: [
  USDC_ON_UNICHAIN.address.toLowerCase(),
  UNI_ON_UNICHAIN.address.toLowerCase(),
],
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep seed-uni-ma-trader`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/seed-uni-ma-trader.ts
git commit -m "feat(seed): allowedTokens + human-decimal swap prompts for seed agent"
```

---

## Task 10: Rewrite `coingecko-price-tool` to use TokenRepository

**Files:**
- Modify: `src/ai-tools/providers/coingecko-price-tool.ts`

- [ ] **Step 1: Read current file**

Run: `cat src/ai-tools/providers/coingecko-price-tool.ts`

- [ ] **Step 2: Rewrite the tool**

Replace the entire file with:

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import type { Database } from '../../database/database';
import { UNICHAIN_CHAIN_ID } from '../../constants';

const inputSchema = z.object({
  coingeckoId: z.string().optional().describe('CoinGecko coin id, e.g. "usd-coin". Pass either this OR tokenAddress.'),
  tokenAddress: z.string().optional().describe('0x-prefixed Unichain token address. Resolved to coingeckoId via the catalog. Pass either this OR coingeckoId.'),
});

export function buildCoingeckoPriceTool(
  coingecko: CoingeckoService,
  db: Database,
): AgentTool<typeof inputSchema> {
  return {
    name: 'fetchTokenPriceUSD',
    description:
      'Fetch a token\'s current USD price from CoinGecko. Pass either coingeckoId (preferred) or tokenAddress (Unichain). Returns JSON {price, currency, source}.',
    inputSchema,
    async invoke({ coingeckoId, tokenAddress }) {
      let id = coingeckoId;
      if (!id) {
        if (!tokenAddress) {
          throw new Error('one of coingeckoId or tokenAddress is required');
        }
        const tok = await db.tokens.findByAddress(tokenAddress, UNICHAIN_CHAIN_ID);
        if (!tok) throw new Error(`token not in catalog: ${tokenAddress}`);
        if (!tok.coingeckoId) throw new Error(`token has no coingeckoId: ${tokenAddress}`);
        id = tok.coingeckoId;
      }
      const price = await coingecko.fetchTokenPriceUSD(id);
      return { price, currency: 'USD', source: 'coingecko', coingeckoId: id };
    },
  };
}
```

> **Note:** `UNICHAIN_CHAIN_ID` should already be exported from `src/constants/unichain.ts` (the spec calls Unichain chainId 130). If the constant has a different name, use the existing one — verify via `grep -n "UNICHAIN" src/constants/unichain.ts`. If missing, export it now: add `export const UNICHAIN_CHAIN_ID = 130;` to `src/constants/unichain.ts`.

- [ ] **Step 3: Verify chain id constant**

Run: `grep -n "130\|chainId\|UNICHAIN" src/constants/unichain.ts`
If no `UNICHAIN_CHAIN_ID` export, add it:
```ts
export const UNICHAIN_CHAIN_ID = 130;
```
Re-export from `src/constants/index.ts` if needed.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep coingecko-price-tool`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ai-tools/providers/coingecko-price-tool.ts src/constants/unichain.ts src/constants/index.ts
git commit -m "feat(ai-tools): coingecko-price-tool uses TokenRepository for address→coingeckoId"
```

---

## Task 11: Add token info AI tools (find-by-symbol, get-by-address, list-allowed)

**Files:**
- Create: `src/ai-tools/tokens/find-tokens-by-symbol-tool.ts`
- Create: `src/ai-tools/tokens/get-token-by-address-tool.ts`
- Create: `src/ai-tools/tokens/list-allowed-tokens-tool.ts`

- [ ] **Step 1: Create `find-tokens-by-symbol-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN_CHAIN_ID } from '../../constants';

const inputSchema = z.object({
  symbol: z.string().min(1).describe('Token symbol, e.g. "USDC". Case-sensitive (matches the canonical symbol).'),
});

export function buildFindTokensBySymbolTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'findTokensBySymbol',
    description:
      'Look up Unichain tokens by symbol from the catalog. Multiple matches possible (forks share symbols). Returns JSON {tokens: [{address, symbol, name, decimals, coingeckoId}]}.',
    inputSchema,
    async invoke({ symbol }) {
      const tokens = await db.tokens.findBySymbol(symbol, UNICHAIN_CHAIN_ID);
      return {
        tokens: tokens.map((t) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          coingeckoId: t.coingeckoId,
        })),
      };
    },
  };
}
```

- [ ] **Step 2: Create `get-token-by-address-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN_CHAIN_ID } from '../../constants';

const inputSchema = z.object({
  address: z.string().describe('0x-prefixed Unichain token address.'),
});

export function buildGetTokenByAddressTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'getTokenByAddress',
    description:
      'Get token info from the Unichain catalog by address. Returns JSON token | null.',
    inputSchema,
    async invoke({ address }) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error(`address must be 0x-prefixed 40-char hex; got ${address}`);
      }
      const t = await db.tokens.findByAddress(address, UNICHAIN_CHAIN_ID);
      return t
        ? {
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            coingeckoId: t.coingeckoId,
          }
        : null;
    },
  };
}
```

- [ ] **Step 3: Create `list-allowed-tokens-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN_CHAIN_ID } from '../../constants';

const inputSchema = z.object({}).describe('No arguments required');

export function buildListAllowedTokensTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'listAllowedTokens',
    description:
      'List the tokens this agent is allowed to trade. Returns JSON {tokens: [{address, symbol, name, decimals, coingeckoId}]}. Empty array means swapping is disabled — ask the operator to update the agent.',
    inputSchema,
    async invoke(_input, ctx) {
      if (ctx.agent.allowedTokens.length === 0) {
        return { tokens: [] };
      }
      const tokens = await db.tokens.findManyByAddresses(
        ctx.agent.allowedTokens,
        UNICHAIN_CHAIN_ID,
      );
      return {
        tokens: tokens.map((t) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          coingeckoId: t.coingeckoId,
        })),
      };
    },
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "tokens/(find|get|list)"`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ai-tools/tokens/
git commit -m "feat(ai-tools): add token catalog tools (findBySymbol, getByAddress, listAllowed)"
```

---

## Task 12: Add utility tools (formatTokenAmount, parseTokenAmount) — TDD

**Files:**
- Create: `src/ai-tools/utility/format-token-amount-tool.ts`
- Create: `src/ai-tools/utility/parse-token-amount-tool.ts`
- Create: `src/ai-tools/utility/format-token-amount-tool.test.ts`
- Create: `src/ai-tools/utility/parse-token-amount-tool.test.ts`

- [ ] **Step 1: Write failing test for formatTokenAmount**

Create `src/ai-tools/utility/format-token-amount-tool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildFormatTokenAmountTool } from './format-token-amount-tool';

describe('formatTokenAmount tool', () => {
  const tool = buildFormatTokenAmountTool();

  it('formats USDC raw to 6-decimal human', async () => {
    const out = await tool.invoke({ rawAmount: '1234567', decimals: 6 }, {} as never);
    expect(out).toEqual({ formatted: '1.234567' });
  });

  it('formats UNI raw with 18 decimals', async () => {
    const out = await tool.invoke({ rawAmount: '1500000000000000000', decimals: 18 }, {} as never);
    expect(out).toEqual({ formatted: '1.5' });
  });

  it('handles zero', async () => {
    const out = await tool.invoke({ rawAmount: '0', decimals: 18 }, {} as never);
    expect(out).toEqual({ formatted: '0' });
  });

  it('rejects non-bigint string', async () => {
    await expect(tool.invoke({ rawAmount: '1.5', decimals: 6 }, {} as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

Run: `npm test -- format-token-amount-tool`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `format-token-amount-tool.ts`**

```ts
import { z } from 'zod';
import { formatUnits } from 'viem';
import type { AgentTool } from '../tool';

const inputSchema = z.object({
  rawAmount: z.string().describe('Bigint as string in token base units, e.g. "1234567" for 1.234567 USDC.'),
  decimals: z.number().int().min(0).max(36).describe('Token decimals, e.g. 6 for USDC, 18 for UNI.'),
});

export function buildFormatTokenAmountTool(): AgentTool<typeof inputSchema> {
  return {
    name: 'formatTokenAmount',
    description:
      'Convert a raw bigint token amount to a human-decimal string. Returns JSON {formatted}. Use this for displaying balances/amounts to the operator.',
    inputSchema,
    async invoke({ rawAmount, decimals }) {
      const raw = BigInt(rawAmount);
      return { formatted: formatUnits(raw, decimals) };
    },
  };
}
```

- [ ] **Step 4: Run test (expect pass)**

Run: `npm test -- format-token-amount-tool`
Expected: PASS.

- [ ] **Step 5: Write failing test for parseTokenAmount**

Create `src/ai-tools/utility/parse-token-amount-tool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildParseTokenAmountTool } from './parse-token-amount-tool';

describe('parseTokenAmount tool', () => {
  const tool = buildParseTokenAmountTool();

  it('parses 0.01 USDC', async () => {
    const out = await tool.invoke({ humanAmount: '0.01', decimals: 6 }, {} as never);
    expect(out).toEqual({ rawAmount: '10000' });
  });

  it('parses 1.5 UNI', async () => {
    const out = await tool.invoke({ humanAmount: '1.5', decimals: 18 }, {} as never);
    expect(out).toEqual({ rawAmount: '1500000000000000000' });
  });

  it('parses integer', async () => {
    const out = await tool.invoke({ humanAmount: '100', decimals: 6 }, {} as never);
    expect(out).toEqual({ rawAmount: '100000000' });
  });

  it('rejects non-numeric', async () => {
    await expect(tool.invoke({ humanAmount: 'oops', decimals: 6 }, {} as never)).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run test (expect fail)**

Run: `npm test -- parse-token-amount-tool`
Expected: FAIL.

- [ ] **Step 7: Implement `parse-token-amount-tool.ts`**

```ts
import { z } from 'zod';
import { parseUnits } from 'viem';
import type { AgentTool } from '../tool';

const inputSchema = z.object({
  humanAmount: z.string().describe('Human decimal string, e.g. "0.01" or "1.5" or "100".'),
  decimals: z.number().int().min(0).max(36).describe('Token decimals.'),
});

export function buildParseTokenAmountTool(): AgentTool<typeof inputSchema> {
  return {
    name: 'parseTokenAmount',
    description:
      'Convert a human-decimal token amount to a raw bigint string in base units. Returns JSON {rawAmount}.',
    inputSchema,
    async invoke({ humanAmount, decimals }) {
      const raw = parseUnits(humanAmount, decimals);
      return { rawAmount: raw.toString() };
    },
  };
}
```

- [ ] **Step 8: Run test (expect pass)**

Run: `npm test -- parse-token-amount-tool`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ai-tools/utility/
git commit -m "feat(ai-tools): add formatTokenAmount + parseTokenAmount utility tools"
```

---

## Task 13: Rewrite swap + quote tools — address input + decimal resolution + allowlist gate

**Files:**
- Modify: `src/ai-tools/uniswap/uniswap-quote-tool.ts`
- Modify: `src/ai-tools/uniswap/uniswap-swap-tool.ts`

- [ ] **Step 1: Rewrite `uniswap-quote-tool.ts`**

```ts
import { z } from 'zod';
import { parseUnits } from 'viem';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import type { Database } from '../../database/database';
import type { FeeTier } from '../../uniswap/types';
import { UNICHAIN_CHAIN_ID } from '../../constants';

const inputSchema = z.object({
  tokenInAddress: z.string().describe('0x-prefixed Unichain address of input token.'),
  tokenOutAddress: z.string().describe('0x-prefixed Unichain address of output token.'),
  amountIn: z.string().describe('Human-decimal string of input amount, e.g. "0.5". Server resolves decimals from the token catalog.'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000.'),
});

export function buildUniswapQuoteTool(
  svc: UniswapService,
  db: Database,
): AgentTool<typeof inputSchema> {
  return {
    name: 'getUniswapQuoteExactIn',
    description:
      'Quote a Uniswap v4 swap on Unichain for an exact input amount. Pass token addresses and a human-decimal amountIn. Returns JSON {amountOut, amountOutFormatted, feeTier, tokenIn, tokenOut}.',
    inputSchema,
    async invoke({ tokenInAddress, tokenOutAddress, amountIn, feeTier }) {
      const [inToken, outToken] = await db.tokens.findManyByAddresses(
        [tokenInAddress, tokenOutAddress],
        UNICHAIN_CHAIN_ID,
      ).then((rows) => {
        const map = new Map(rows.map((t) => [t.address, t]));
        return [
          map.get(tokenInAddress.toLowerCase()),
          map.get(tokenOutAddress.toLowerCase()),
        ];
      });
      if (!inToken) throw new Error(`token not in catalog: ${tokenInAddress}`);
      if (!outToken) throw new Error(`token not in catalog: ${tokenOutAddress}`);

      const tier: FeeTier = feeTier ?? 3_000;
      const amountInRaw = parseUnits(amountIn, inToken.decimals);
      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address as `0x${string}`,
        tokenOut: outToken.address as `0x${string}`,
        amountIn: amountInRaw,
        feeTier: tier,
      });
      return {
        amountOut: quote.amountOut.toString(),
        amountOutFormatted: (Number(quote.amountOut) / 10 ** outToken.decimals).toString(),
        feeTier: tier,
        tokenIn: inToken.symbol,
        tokenOut: outToken.symbol,
      };
    },
  };
}
```

- [ ] **Step 2: Rewrite `uniswap-swap-tool.ts`**

```ts
import { z } from 'zod';
import { parseUnits } from 'viem';
import type { AgentTool } from '../tool';
import type { UniswapService } from '../../uniswap/uniswap-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import type { Database } from '../../database/database';
import type { FeeTier } from '../../uniswap/types';
import { UNICHAIN_CHAIN_ID } from '../../constants';

const inputSchema = z.object({
  tokenInAddress: z.string().describe('0x-prefixed Unichain address of input token. MUST be in the agent allowlist.'),
  tokenOutAddress: z.string().describe('0x-prefixed Unichain address of output token. MUST be in the agent allowlist.'),
  amountIn: z.string().describe('Human-decimal input amount, e.g. "0.01" for 0.01 USDC. Server resolves decimals.'),
  slippageBps: z.number().int().min(1).max(10_000).optional()
    .describe('Max slippage in basis points. Defaults to and is capped at agent.riskLimits.maxSlippageBps.'),
  feeTier: z.union([z.literal(500), z.literal(3_000), z.literal(10_000)]).optional()
    .describe('Pool fee tier in bps. Defaults to 3000.'),
});

export function buildUniswapSwapTool(
  svc: UniswapService,
  coingecko: CoingeckoService,
  db: Database,
): AgentTool<typeof inputSchema> {
  return {
    name: 'executeUniswapSwapExactIn',
    description:
      'Execute a Uniswap v4 single-pool exact-input swap on Unichain. Token addresses must be in agent.allowedTokens. Risk gate enforces maxTradeUSD + maxSlippageBps. Returns JSON {transactionId, hash, status, opened?, closed?}.',
    inputSchema,
    async invoke({ tokenInAddress, tokenOutAddress, amountIn, slippageBps, feeTier }, ctx) {
      const inAddr = tokenInAddress.toLowerCase();
      const outAddr = tokenOutAddress.toLowerCase();
      const allowSet = new Set(ctx.agent.allowedTokens.map((a) => a.toLowerCase()));

      if (!allowSet.has(inAddr)) {
        throw new Error(`token not in agent allowlist: ${tokenInAddress}`);
      }
      if (!allowSet.has(outAddr)) {
        throw new Error(`token not in agent allowlist: ${tokenOutAddress}`);
      }

      const tokens = await db.tokens.findManyByAddresses([inAddr, outAddr], UNICHAIN_CHAIN_ID);
      const map = new Map(tokens.map((t) => [t.address, t]));
      const inToken = map.get(inAddr);
      const outToken = map.get(outAddr);
      if (!inToken) throw new Error(`token not in catalog: ${tokenInAddress}`);
      if (!outToken) throw new Error(`token not in catalog: ${tokenOutAddress}`);
      if (!inToken.coingeckoId) throw new Error(`tokenIn missing coingeckoId for USD risk math: ${inToken.address}`);
      if (!outToken.coingeckoId) throw new Error(`tokenOut missing coingeckoId for USD risk math: ${outToken.address}`);

      const maxSlippageBps = ctx.agent.riskLimits.maxSlippageBps;
      const requestedSlippage = slippageBps ?? maxSlippageBps;
      if (requestedSlippage > maxSlippageBps) {
        throw new Error(`requested slippage ${requestedSlippage}bps exceeds agent maxSlippageBps ${maxSlippageBps}`);
      }

      const tier: FeeTier = feeTier ?? 3_000;
      const amountInRaw = parseUnits(amountIn, inToken.decimals);

      const quote = await svc.getQuoteExactIn({
        tokenIn: inToken.address as `0x${string}`,
        tokenOut: outToken.address as `0x${string}`,
        amountIn: amountInRaw,
        feeTier: tier,
      });

      const inPriceUSD = await coingecko.fetchTokenPriceUSD(inToken.coingeckoId);
      const outPriceUSD = await coingecko.fetchTokenPriceUSD(outToken.coingeckoId);
      const inputUSD = (Number(amountInRaw) / 10 ** inToken.decimals) * inPriceUSD;
      const expectedOutputUSD = (Number(quote.amountOut) / 10 ** outToken.decimals) * outPriceUSD;

      const maxTradeUSD = ctx.agent.riskLimits.maxTradeUSD;
      if (inputUSD > maxTradeUSD) {
        throw new Error(`trade ${inputUSD.toFixed(2)} USD exceeds agent maxTradeUSD ${maxTradeUSD}`);
      }

      const amountOutMinimum = (quote.amountOut * BigInt(10_000 - requestedSlippage)) / 10_000n;

      const result = await svc.executeSwapExactIn(
        {
          tokenIn: { tokenAddress: inToken.address, symbol: inToken.symbol, decimals: inToken.decimals, amountRaw: amountInRaw.toString() },
          tokenOut: { tokenAddress: outToken.address, symbol: outToken.symbol, decimals: outToken.decimals, amountRaw: quote.amountOut.toString() },
          amountOutMinimum,
          feeTier: tier,
          inputUSD,
          expectedOutputUSD,
        },
        ctx.agent,
        ctx.wallet,
      );

      return {
        transactionId: result.swapTx.id,
        hash: result.swapTx.hash,
        status: result.swapTx.status,
        amountIn: amountInRaw.toString(),
        amountOutEstimated: quote.amountOut.toString(),
        amountOutMinimum: amountOutMinimum.toString(),
        feeTier: tier,
        slippageBps: requestedSlippage,
        approvalTxIds: result.approvalTxs.map((t) => t.id),
        ...(result.opened ? { openedPositionId: result.opened.id } : {}),
        ...(result.closed
          ? { closedPositionId: result.closed.id, realizedPnlUSD: result.closed.realizedPnlUSD }
          : {}),
      };
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep uniswap-`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ai-tools/uniswap/uniswap-quote-tool.ts src/ai-tools/uniswap/uniswap-swap-tool.ts
git commit -m "feat(ai-tools): swap+quote take addresses + human decimals; swap enforces allowlist"
```

---

## Task 14: Enrich `getNativeBalance` + `getTokenBalance` responses

**Files:**
- Modify: `src/ai-tools/wallet/wallet-balance-tools.ts`

- [ ] **Step 1: Rewrite `wallet-balance-tools.ts`**

```ts
import { z } from 'zod';
import { formatUnits, erc20Abi, createPublicClient, http } from 'viem';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import { UNICHAIN_CHAIN_ID, resolveUnichainRpcUrl } from '../../constants';

const nativeInput = z.object({}).describe('No arguments required');
const tokenInput = z.object({
  tokenAddress: z.string().describe('ERC-20 contract address (0x-prefixed)'),
});

export function buildWalletBalanceTools(db: Database): [
  AgentTool<typeof nativeInput>,
  AgentTool<typeof tokenInput>,
] {
  const nativeBalance: AgentTool<typeof nativeInput> = {
    name: 'getNativeBalance',
    description:
      'Read the native (ETH) balance for the agent wallet on Unichain. Returns JSON {raw, formatted, decimals, symbol}. raw is wei as a string; formatted is the human ETH amount.',
    inputSchema: nativeInput,
    async invoke(_input, ctx) {
      const wei = await ctx.wallet.getNativeBalance();
      return {
        raw: wei.toString(),
        formatted: formatUnits(wei, 18),
        decimals: 18,
        symbol: 'ETH',
      };
    },
  };

  const tokenBalance: AgentTool<typeof tokenInput> = {
    name: 'getTokenBalance',
    description:
      'Read the ERC-20 balance for the agent wallet on Unichain. Returns JSON {tokenAddress, raw, formatted, decimals, symbol}. Decimals + symbol resolved from the token catalog (or on-chain if unknown).',
    inputSchema: tokenInput,
    async invoke({ tokenAddress }, ctx) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
        throw new Error(`tokenAddress must be a 0x-prefixed 40-char hex address; got ${tokenAddress}`);
      }
      const lower = tokenAddress.toLowerCase();
      const raw = await ctx.wallet.getTokenBalance(tokenAddress as `0x${string}`);

      const cataloged = await db.tokens.findByAddress(lower, UNICHAIN_CHAIN_ID);
      let decimals: number;
      let symbol: string;
      if (cataloged) {
        decimals = cataloged.decimals;
        symbol = cataloged.symbol;
      } else {
        const client = createPublicClient({ transport: http(resolveUnichainRpcUrl()) });
        const [d, s] = await Promise.all([
          client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
          client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }).catch(() => '<unknown>'),
        ]);
        decimals = d as number;
        symbol = s as string;
      }
      return {
        tokenAddress: lower,
        raw: raw.toString(),
        formatted: formatUnits(raw, decimals),
        decimals,
        symbol,
      };
    },
  };

  return [nativeBalance, tokenBalance];
}
```

- [ ] **Step 2: Verify `resolveUnichainRpcUrl` export exists**

Run: `grep -n "resolveUnichainRpcUrl\|UNICHAIN_RPC" src/constants/unichain.ts src/constants/index.ts`
Expected: at least one match exporting a callable. If not, replace `resolveUnichainRpcUrl()` with whatever the existing helper is named (e.g. `getUnichainRpcUrl()`); inspect [src/balance/balance-service.ts](../../../src/balance/balance-service.ts) which already uses this helper.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep wallet-balance`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ai-tools/wallet/wallet-balance-tools.ts
git commit -m "feat(ai-tools): enrich balance tools with formatted/decimals/symbol"
```

---

## Task 15: Wire all new tools into `ToolRegistry`

**Files:**
- Modify: `src/ai-tools/tool-registry.ts`
- Modify: `src/ai-tools/tool-registry.test.ts`

- [ ] **Step 1: Edit `tool-registry.ts`**

Replace the file contents:

```ts
import type { AgentTool } from './tool';
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
import type { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import type { SerperService } from '../providers/serper/serper-service';
import type { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { Database } from '../database/database';
import type { UniswapService } from '../uniswap/uniswap-service';
import { buildCoingeckoPriceTool } from './providers/coingecko-price-tool';
import { buildCoinMarketCapInfoTool } from './providers/coinmarketcap-info-tool';
import { buildSerperSearchTool } from './providers/serper-search-tool';
import { buildFirecrawlScrapeTool } from './providers/firecrawl-scrape-tool';
import { buildWalletBalanceTools } from './wallet/wallet-balance-tools';
import { buildReadMemoryTool } from './memory/read-memory-tool';
import { buildUpdateMemoryTool } from './memory/update-memory-tool';
import { buildSaveMemoryEntryTool } from './memory/save-memory-entry-tool';
import { buildSearchMemoryEntriesTool } from './memory/search-memory-entries-tool';
import { buildUniswapQuoteTool } from './uniswap/uniswap-quote-tool';
import { buildUniswapSwapTool } from './uniswap/uniswap-swap-tool';
import { buildFindTokensBySymbolTool } from './tokens/find-tokens-by-symbol-tool';
import { buildGetTokenByAddressTool } from './tokens/get-token-by-address-tool';
import { buildListAllowedTokensTool } from './tokens/list-allowed-tokens-tool';
import { buildFormatTokenAmountTool } from './utility/format-token-amount-tool';
import { buildParseTokenAmountTool } from './utility/parse-token-amount-tool';

export interface ToolRegistryDeps {
  coingecko: CoingeckoService;
  coinmarketcap: CoinMarketCapService;
  serper: SerperService;
  firecrawl: FirecrawlService;
  db: Database;
  uniswap: UniswapService;
}

export class ToolRegistry {
  constructor(private readonly deps: ToolRegistryDeps) {}

  build(): AgentTool[] {
    const [nativeBalance, tokenBalance] = buildWalletBalanceTools(this.deps.db);
    return [
      buildCoingeckoPriceTool(this.deps.coingecko, this.deps.db),
      buildCoinMarketCapInfoTool(this.deps.coinmarketcap),
      buildSerperSearchTool(this.deps.serper),
      buildFirecrawlScrapeTool(this.deps.firecrawl),
      nativeBalance,
      tokenBalance,
      buildReadMemoryTool(this.deps.db),
      buildUpdateMemoryTool(this.deps.db),
      buildSaveMemoryEntryTool(this.deps.db),
      buildSearchMemoryEntriesTool(this.deps.db),
      buildUniswapQuoteTool(this.deps.uniswap, this.deps.db),
      buildUniswapSwapTool(this.deps.uniswap, this.deps.coingecko, this.deps.db),
      buildFindTokensBySymbolTool(this.deps.db),
      buildGetTokenByAddressTool(this.deps.db),
      buildListAllowedTokensTool(this.deps.db),
      buildFormatTokenAmountTool(),
      buildParseTokenAmountTool(),
    ];
  }
}
```

- [ ] **Step 2: Update `tool-registry.test.ts` expected list**

Edit the test that asserts the tool name list. Add the five new tool names:
```ts
'findTokensBySymbol',
'getTokenByAddress',
'listAllowedTokens',
'formatTokenAmount',
'parseTokenAmount',
```
Insert them after `'getTokenBalance'` to match registration order, or alphabetize if the test does — read the file first and match its style.

- [ ] **Step 3: Run unit tests**

Run: `npm test -- tool-registry.test`
Expected: PASS (`tool-registry.live.test` updated separately in Task 16).

- [ ] **Step 4: Commit**

```bash
git add src/ai-tools/tool-registry.ts src/ai-tools/tool-registry.test.ts
git commit -m "feat(ai-tools): register token catalog + utility tools in ToolRegistry"
```

---

## Task 16: Update `tool-registry.live.test.ts` for new shapes

**Files:**
- Modify: `src/ai-tools/tool-registry.live.test.ts`

- [ ] **Step 1: Replace TOKENS imports + constructor fixtures**

Replace:
```ts
import { TOKENS } from '../constants';
```
with:
```ts
import { USDC_ON_UNICHAIN } from '../constants';
```

Replace `TOKENS.USDC.address` → `USDC_ON_UNICHAIN.address`. Update the `dryRunSeedBalances` map keys accordingly.

- [ ] **Step 2: Add `allowedTokens` to seeded test agent**

In the test agent config, add:
```ts
allowedTokens: [USDC_ON_UNICHAIN.address.toLowerCase()],
```

- [ ] **Step 3: Update `getTokenBalance` assertion**

The result shape changed — now `{ tokenAddress, raw, formatted, decimals, symbol }`. Update the assertion (e.g. `expect(result.raw).toBe('5000000')` plus `expect(result.formatted).toBe('5')`, `expect(result.decimals).toBe(6)`, `expect(result.symbol).toBe('USDC')`).

- [ ] **Step 4: Reseed tokens before test (if not already done)**

Verify the live test seeds the `Token` table for USDC at start (Task 5 test does so for that file's scope, but `tool-registry.live.test.ts` runs against the same DB — the seed-tokens step from `npm run db:seed` should leave USDC present. If the test fails on `getTokenBalance`, run `npm run db:seed` once locally before re-running.)

- [ ] **Step 5: Run live test**

Run: `npm test -- tool-registry.live`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai-tools/tool-registry.live.test.ts
git commit -m "test(ai-tools): update live registry test for allowedTokens + enriched balance shape"
```

---

## Task 17: OpenAPI schemas — Token + extend agent body schemas

**Files:**
- Modify: `src/api-server/openapi/schemas.ts`

- [ ] **Step 1: Add Token zod schemas**

Insert after the existing `UserWalletSchema` block (or wherever fits the file's grouping):

```ts
export const TokenViewSchema = z.object({
  id: z.number().int(),
  chainId: z.number().int(),
  chain: z.string(),
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int(),
  logoUri: z.string().nullable(),
  coingeckoId: z.string().nullable(),
}).openapi('TokenView');

export const TokensListResponseSchema = z.object({
  tokens: z.array(TokenViewSchema),
  nextCursor: z.string().nullable(),
}).openapi('TokensListResponse');

export const AllowedTokensResponseSchema = z.object({
  tokens: z.array(TokenViewSchema),
}).openapi('AllowedTokensResponse');

export const UnknownTokensErrorSchema = z.object({
  error: z.literal('unknown_tokens'),
  unknownAddresses: z.array(z.string()),
}).openapi('UnknownTokensError');
```

- [ ] **Step 2: Extend `AgentConfigSchema`, `CreateAgentBodySchema`, `UpdateAgentBodySchema`**

Add to each:
```ts
allowedTokens: z.array(z.string()).optional()
```

(`AgentConfigSchema` should mark it required since DB rows always have it — use `z.array(z.string())` without `.optional()` there. Bodies stay optional.)

Concretely for `AgentConfigSchema`, replace:
```ts
export const AgentConfigSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  prompt: z.string(),
  dryRun: z.boolean(),
  dryRunSeedBalances: z.record(z.string()).optional(),
  allowedTokens: z.array(z.string()),
  riskLimits: RiskLimitsSchema,
  createdAt: z.number(),
  running: z.boolean().optional(),
  intervalMs: z.number().int().nonnegative().optional(),
  lastTickAt: z.number().nullable().optional(),
}).openapi('AgentConfig');
```

For `CreateAgentBodySchema`, add `allowedTokens: z.array(z.string()).optional()` line. Same for `UpdateAgentBodySchema`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep schemas`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/api-server/openapi/schemas.ts
git commit -m "feat(openapi): add TokenView/list/allowed-tokens schemas + allowedTokens on agent"
```

---

## Task 18: GET /tokens route + mounting

**Files:**
- Create: `src/api-server/routes/tokens.ts`
- Modify: `src/api-server/server.ts`

- [ ] **Step 1: Create `src/api-server/routes/tokens.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/database';

interface Deps {
  db: Database;
}

const QuerySchema = z.object({
  chainId: z.coerce.number().int().optional(),
  symbol: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function buildTokensRouter(deps: Deps): Router {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const q = QuerySchema.parse(req.query);
      const page = await deps.db.tokens.list(q);
      res.json(page);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
```

- [ ] **Step 2: Mount in `server.ts`**

In `src/api-server/server.ts`, add import:
```ts
import { buildTokensRouter } from './routes/tokens';
```

Inside the constructor body, after the auth middleware and other route mounts, add:
```ts
this.app.use('/tokens', buildTokensRouter({ db: deps.db }));
```

(Anywhere alongside `/agents` is fine; the auth middleware applies because mounting comes after `buildAuthMiddleware`.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep tokens`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/api-server/routes/tokens.ts src/api-server/server.ts
git commit -m "feat(api): add GET /tokens with pagination + filters"
```

---

## Task 19: Extend POST/PATCH /agents with `allowedTokens` validation + GET /agents/:id/allowed-tokens

**Files:**
- Modify: `src/api-server/routes/agents.ts`

- [ ] **Step 1: Edit imports**

Add to the top:
```ts
import { UNICHAIN_CHAIN_ID } from '../../constants';
```

- [ ] **Step 2: Add helper for validation**

Inside `buildAgentsRouter`, add helper before route handlers:

```ts
async function validateAndNormalizeAllowedTokens(addresses: string[]): Promise<string[]> {
  const lowered = Array.from(new Set(addresses.map((a) => a.toLowerCase())));
  if (lowered.length === 0) return [];
  const found = await deps.db.tokens.findManyByAddresses(lowered, UNICHAIN_CHAIN_ID);
  const foundSet = new Set(found.map((t) => t.address));
  const unknown = lowered.filter((a) => !foundSet.has(a));
  if (unknown.length > 0) {
    const err = new Error('unknown tokens');
    (err as Error & { code?: string; unknownAddresses?: string[] }).code = 'unknown_tokens';
    (err as Error & { code?: string; unknownAddresses?: string[] }).unknownAddresses = unknown;
    throw err;
  }
  return lowered;
}
```

- [ ] **Step 3: Update POST handler**

In `r.post('/', ...)`, after parsing the body, validate `allowedTokens`:

```ts
r.post('/', async (req, res, next) => {
  try {
    const body = CreateAgentBodySchema.parse(req.body);
    const allowedTokens = body.allowedTokens
      ? await validateAndNormalizeAllowedTokens(body.allowedTokens)
      : [];
    const agent: AgentConfig = {
      id: randomUUID(),
      userId: req.user!.id,
      name: body.name,
      prompt: body.prompt,
      dryRun: body.dryRun,
      ...(body.dryRunSeedBalances ? { dryRunSeedBalances: body.dryRunSeedBalances } : {}),
      allowedTokens,
      riskLimits: body.riskLimits,
      createdAt: now(),
      running: false,
      lastTickAt: null,
      ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
    };
    await deps.db.agents.upsert(agent);
    res.status(201).json(agent);
  } catch (err) {
    if ((err as { code?: string }).code === 'unknown_tokens') {
      res.status(400).json({
        error: 'unknown_tokens',
        unknownAddresses: (err as Error & { unknownAddresses?: string[] }).unknownAddresses ?? [],
      });
      return;
    }
    next(err);
  }
});
```

- [ ] **Step 4: Update PATCH handler**

```ts
r.patch('/:id', async (req, res, next) => {
  try {
    const body = UpdateAgentBodySchema.parse(req.body);
    const agent = await deps.db.agents.findById(req.params.id);
    if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();

    let allowedTokensPatch: string[] | undefined;
    if (body.allowedTokens !== undefined) {
      allowedTokensPatch = await validateAndNormalizeAllowedTokens(body.allowedTokens);
    }

    const updated: AgentConfig = {
      ...agent,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.riskLimits !== undefined ? { riskLimits: body.riskLimits } : {}),
      ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
      ...(allowedTokensPatch !== undefined ? { allowedTokens: allowedTokensPatch } : {}),
    };
    await deps.db.agents.upsert(updated);
    res.json(updated);
  } catch (err) {
    if ((err as { code?: string }).code === 'unknown_tokens') {
      res.status(400).json({
        error: 'unknown_tokens',
        unknownAddresses: (err as Error & { unknownAddresses?: string[] }).unknownAddresses ?? [],
      });
      return;
    }
    next(err);
  }
});
```

- [ ] **Step 5: Add GET /:id/allowed-tokens**

Append before `return r;`:

```ts
r.get('/:id/allowed-tokens', async (req, res, next) => {
  try {
    const agent = await deps.db.agents.findById(req.params.id);
    if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
    const tokens = await deps.db.tokens.findManyByAddresses(
      agent.allowedTokens,
      UNICHAIN_CHAIN_ID,
    );
    res.json({ tokens });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep agents.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/api-server/routes/agents.ts
git commit -m "feat(api): allowedTokens validation + GET /agents/:id/allowed-tokens"
```

---

## Task 20: OpenAPI spec-builder — register new + updated paths

**Files:**
- Modify: `src/api-server/openapi/spec-builder.ts`

- [ ] **Step 1: Add imports**

In the import block at top, add:

```ts
import {
  // ...existing imports
  TokenViewSchema,
  TokensListResponseSchema,
  AllowedTokensResponseSchema,
  UnknownTokensErrorSchema,
} from './schemas';
```

- [ ] **Step 2: Register GET /tokens**

Inside `registerPaths()`, add:

```ts
registry.registerPath({
  method: 'get',
  path: '/tokens',
  description: 'Catalog of supported tokens, paginated. Filter by chainId, symbol, or search (matches symbol or name, case-insensitive).',
  request: {
    query: z.object({
      chainId: z.coerce.number().int().optional(),
      symbol: z.string().optional(),
      search: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  },
  responses: {
    200: { description: 'page of tokens', content: { 'application/json': { schema: TokensListResponseSchema } } },
    401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
```

- [ ] **Step 3: Register GET /agents/:id/allowed-tokens**

```ts
registry.registerPath({
  method: 'get',
  path: '/agents/{id}/allowed-tokens',
  description: 'Returns the resolved Token rows in the agent\'s allowlist.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'allowed tokens', content: { 'application/json': { schema: AllowedTokensResponseSchema } } },
    401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'agent not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
```

- [ ] **Step 4: Add 400 to existing POST/PATCH /agents responses**

Find the existing `registry.registerPath({ method: 'post', path: '/agents', ... })` block. Add the 400 response:

```ts
400: { description: 'unknown tokens in allowlist', content: { 'application/json': { schema: UnknownTokensErrorSchema } } },
```

Same for the PATCH /agents/{id} registration.

- [ ] **Step 5: Generate the spec to verify**

Run: `npm run start:server` in one terminal, then in another: `curl http://localhost:3000/docs/openapi.json | jq '.paths | keys' | head -20`
Expected: `/tokens` and `/agents/{id}/allowed-tokens` appear.

(If there is no helper script, just `npx tsc --noEmit` to confirm no compile errors and trust the spec generation will pick up the new registrations at runtime.)

- [ ] **Step 6: Commit**

```bash
git add src/api-server/openapi/spec-builder.ts
git commit -m "docs(openapi): register /tokens, allowed-tokens, and unknown_tokens 400"
```

---

## Task 21: Seed enrichment — fetch CoinGecko coin list, populate `Token.coingeckoId`

**Files:**
- Modify: `prisma/seed-tokens.ts`

- [ ] **Step 1: Edit `prisma/seed-tokens.ts`**

Replace the file with the enriched version:

```ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CHAIN_ID_TO_NAME: Record<number, string> = { 130: 'unichain' };
const TOKEN_LIST_URLS: Record<string, string> = {
  unichain: 'https://tokens.coingecko.com/unichain/all.json',
};
const COINGECKO_COINS_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const COINGECKO_CACHE_PATH = path.resolve(process.cwd(), 'db', 'coingecko-coins-list.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CoinGeckoToken {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

interface CoinGeckoTokenList {
  tokens: CoinGeckoToken[];
}

interface CoinGeckoCoin {
  id: string;
  symbol: string;
  name: string;
  platforms: Record<string, string | null>;
}

async function fetchTokenList(url: string): Promise<CoinGeckoToken[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch token list: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as CoinGeckoTokenList;
  return data.tokens;
}

async function loadCoingeckoCoinList(): Promise<CoinGeckoCoin[]> {
  try {
    const stat = await fs.stat(COINGECKO_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < CACHE_TTL_MS) {
      const buf = await fs.readFile(COINGECKO_CACHE_PATH, 'utf8');
      return JSON.parse(buf) as CoinGeckoCoin[];
    }
  } catch {
    // cache miss
  }
  console.log(`[seed-tokens] fetching CoinGecko coin list (~10MB) from ${COINGECKO_COINS_LIST_URL}...`);
  const res = await fetch(COINGECKO_COINS_LIST_URL);
  if (!res.ok) throw new Error(`coins/list failed: ${res.status} ${res.statusText}`);
  const list = (await res.json()) as CoinGeckoCoin[];
  await fs.mkdir(path.dirname(COINGECKO_CACHE_PATH), { recursive: true });
  await fs.writeFile(COINGECKO_CACHE_PATH, JSON.stringify(list));
  return list;
}

function buildAddressToCoingeckoId(coins: CoinGeckoCoin[], platformKey: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const coin of coins) {
    const addr = coin.platforms?.[platformKey];
    if (addr) map.set(addr.toLowerCase(), coin.id);
  }
  return map;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const coins = await loadCoingeckoCoinList();

    for (const [chain, url] of Object.entries(TOKEN_LIST_URLS)) {
      console.log(`[seed-tokens] fetching ${chain} token list...`);
      const tokens = await fetchTokenList(url);
      console.log(`[seed-tokens] ${tokens.length} tokens fetched`);

      const idMap = buildAddressToCoingeckoId(coins, chain);
      console.log(`[seed-tokens] ${idMap.size} ${chain} addresses have a coingeckoId`);

      let upserted = 0;
      for (const token of tokens) {
        const chainName = CHAIN_ID_TO_NAME[token.chainId] ?? chain;
        const lowerAddr = token.address.toLowerCase();
        const coingeckoId = idMap.get(lowerAddr) ?? null;
        await prisma.token.upsert({
          where: { address_chainId: { address: lowerAddr, chainId: token.chainId } },
          update: {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoUri: token.logoURI ?? null,
            chain: chainName,
            coingeckoId,
          },
          create: {
            chainId: token.chainId,
            chain: chainName,
            address: lowerAddr,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoUri: token.logoURI ?? null,
            coingeckoId,
          },
        });
        upserted++;
      }

      console.log(`[seed-tokens] upserted ${upserted} tokens for chain "${chain}"`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-tokens] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the enriched seed**

Run: `npm run db:seed-tokens` (or whatever script invokes this — check `package.json`. If absent, run `npx tsx prisma/seed-tokens.ts`.)
Expected: console output ends with "upserted N tokens for chain unichain". `db/coingecko-coins-list.json` cache file created.

- [ ] **Step 3: Verify USDC and UNI have coingeckoId**

Run: `npx prisma studio` and inspect Token rows for the two known addresses, OR:
```bash
psql $DATABASE_URL -c "SELECT address, symbol, \"coingeckoId\" FROM \"Token\" WHERE \"chainId\"=130 AND \"coingeckoId\" IN ('usd-coin','uniswap');"
```
Expected: rows for `usd-coin` and `uniswap` present.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed-tokens.ts
git commit -m "feat(seed): enrich Token rows with coingeckoId from CoinGecko coin list"
```

---

## Task 22: GET /tokens live test

**Files:**
- Create: `src/api-server/routes/tokens.live.test.ts`

- [ ] **Step 1: Write the live test**

Create `src/api-server/routes/tokens.live.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaTokenRepository } from '../../database/prisma-database/prisma-token-repository';
import { buildTokensRouter } from './tokens';
import type { Database } from '../../database/database';
import { USDC_ON_UNICHAIN } from '../../constants';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must be set');

const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
const repo = new PrismaTokenRepository(prisma);
const db = { tokens: repo } as unknown as Database;

const app = express();
app.use('/tokens', buildTokensRouter({ db }));

beforeAll(async () => {
  await prisma.token.deleteMany({ where: { chainId: 130 } });
  await prisma.token.create({
    data: {
      chainId: 130,
      chain: 'unichain',
      address: USDC_ON_UNICHAIN.address.toLowerCase(),
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /tokens (live)', () => {
  it('lists tokens with default limit', async () => {
    const res = await fetch(`http://localhost:0/tokens`).catch(() => null); // placeholder

    // Use supertest-style: import supertest if already a project dep, else inline:
    const supertest = (await import('supertest')).default;
    const r = await supertest(app).get('/tokens?chainId=130&limit=50');
    expect(r.status).toBe(200);
    expect(r.body.tokens.length).toBeGreaterThan(0);
    expect(r.body.tokens[0]).toMatchObject({
      address: expect.any(String),
      symbol: expect.any(String),
      decimals: expect.any(Number),
    });
    console.log('GET /tokens body sample:', r.body.tokens[0]);
  });

  it('filters by symbol', async () => {
    const supertest = (await import('supertest')).default;
    const r = await supertest(app).get('/tokens?chainId=130&symbol=USDC');
    expect(r.status).toBe(200);
    expect(r.body.tokens.every((t: { symbol: string }) => t.symbol === 'USDC')).toBe(true);
  });
});
```

> **Note:** If `supertest` is not in `package.json`, add it: `npm install --save-dev supertest @types/supertest`. Verify first with: `node -e "console.log(require('./package.json').devDependencies?.supertest)"`. If missing, install before running the test.

- [ ] **Step 2: Run the test**

Run: `npm test -- tokens.live`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/api-server/routes/tokens.live.test.ts package.json package-lock.json
git commit -m "test(api): live test for GET /tokens"
```

---

## Task 23: Smoke test the seed flow + manual end-to-end

**Files:** none (operational verification)

- [ ] **Step 1: Reset DB**

Run: `npm run db:reset`
Expected: completes; the seed agent installed with `allowedTokens: ['<usdc>', '<uni>']`. Token table re-populated with `coingeckoId` set.

- [ ] **Step 2: Verify seed agent has allowedTokens**

Run:
```bash
psql $DATABASE_URL -c "SELECT id, \"allowedTokens\" FROM \"Agent\" WHERE id='uni-ma-trader-001';"
```
Expected: row shows array with both lowercased addresses.

- [ ] **Step 3: Boot the worker + a single tick (dry-run)**

Run: `npm start` (or `npm run start:worker`) for 1–2 minutes. Inspect logs for tool calls.
Expected: no `TOKENS is not defined` errors; agent uses `getTokenBalance` returning enriched `{raw, formatted, decimals, symbol}`; if the LLM tries to swap, `executeUniswapSwapExactIn` accepts an `amountIn` like `"0.25"` (not a raw bigint).

- [ ] **Step 4: Boot the API server, verify endpoints**

Run: `npm run start:server`
In another terminal:
```bash
# Token catalog (need a Privy bearer token or your local dev auth bypass)
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:3000/tokens?chainId=130&limit=5'

# Allowed-tokens for seed agent
curl -H "Authorization: Bearer $TOKEN" 'http://localhost:3000/agents/uni-ma-trader-001/allowed-tokens'
```
Expected: both return JSON shaped per spec.

- [ ] **Step 5: Verify OpenAPI**

Open `http://localhost:3000/docs` and check that `/tokens` and `/agents/{id}/allowed-tokens` are listed; agent create/patch shows the `allowedTokens` body field and 400 response.

- [ ] **Step 6: Final test sweep**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit any cleanup**

If smoke testing surfaced fixes, commit them:
```bash
git add -p
git commit -m "fix: address smoke-test findings"
```

---

## Self-Review Notes (for agentic worker)

After completing all tasks, verify:

1. **Spec coverage:**
   - Schema changes (Task 1) — covers spec § Schema changes ✓
   - Constants refactor (Task 6) — covers spec § Constants refactor ✓
   - Callsite migration (Tasks 7–9) — covers spec § Callsite migration table ✓
   - TokenRepository (Tasks 4–5) — covers spec § TokenRepository ✓
   - AI tools surface (Tasks 10–15) — covers spec § AI tools surface (token info, utility, swap/quote, balance, coingecko) ✓
   - API endpoints (Tasks 17–20) — covers spec § API endpoints + OpenAPI sync ✓
   - Seed enrichment (Task 21) — covers spec § Seed enrichment ✓
   - Seed agent (Task 9) — covers spec § Seed agent ✓
   - Tests (Tasks 5, 8, 12, 16, 22) — covers spec § Migration order step 8 ✓

2. **No placeholders:** every step contains executable code/commands. Where a name might vary by codebase (`UNICHAIN_CHAIN_ID`, `resolveUnichainRpcUrl`), the plan instructs the worker to grep first and adapt — not skip.

3. **Type consistency:** `Token` shape, `allowedTokens: string[]`, `AgentConfig.allowedTokens` all match across tasks. Tool function signatures match between definition (Tasks 10–14) and registration (Task 15).
