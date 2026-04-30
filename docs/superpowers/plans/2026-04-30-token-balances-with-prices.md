# Token Balances + USD Prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `GET /users/me/zerog/balances` to also return on-chain balances for all DB tokens (Unichain) with USD prices, plus the 0G price/value.

**Architecture:** Add `TokenRepository` to read tokens from DB, extend `CoingeckoService` with a contract-address batch endpoint (`/simple/token_price/{platform}`), extend `BalanceService` with a multicall-based balance fetch for arbitrary tokens, update the zerog router to assemble the enriched response.

**Tech Stack:** Coingecko API (`/simple/token_price/unichain`), viem `multicall` on Unichain, Prisma for DB, zod for OpenAPI schemas.

---

## Files

- Modify: `src/providers/coingecko/coingecko-service.ts` — add `fetchTokenPricesByContract(platform, addresses)`
- Modify: `src/balance/balance-service.ts` — add `fetchTokenBalancesOnUnichain(wallet, tokens)`
- Create: `src/database/repositories/token-repository.ts` — interface
- Create: `src/database/prisma-database/prisma-token-repository.ts` — Prisma impl
- Modify: `src/database/database.ts` — add `tokens` to Database interface
- Modify: `src/database/prisma-database/prisma-database.ts` — wire `tokens` repo
- Modify: `src/database/types.ts` — add `Token` domain type
- Modify: `prisma/seed.ts` — seed USDC + UNI on Unichain
- Modify: `src/constants/unichain.ts` — add `UNICHAIN_COINGECKO_PLATFORM`
- Modify: `src/api-server/routes/zerog.ts` — call new services, enrich response
- Modify: `src/api-server/openapi/schemas.ts` — add `TokenBalance` + extend `ZeroGBalancesResponse`
- Modify: `src/api-server/openapi/spec-builder.ts` — keep registration current (no path change, schemas auto-update)

---

### Task 1: Add Coingecko contract-address price lookup

**Files:**
- Modify: `src/providers/coingecko/coingecko-service.ts`

- [ ] **Step 1: Read the file**

Read `src/providers/coingecko/coingecko-service.ts` to confirm pattern. The class has `fetchTokenPriceUSD(coingeckoId)` using GET `/simple/price?ids=...&vs_currencies=usd` with `x-cg-demo-api-key` header.

- [ ] **Step 2: Add the new method**

Append this method to the `CoingeckoService` class (after `fetchTokenPriceUSD`):

```typescript
async fetchTokenPricesByContract(
  platform: string,
  addresses: string[],
): Promise<Record<string, number>> {
  if (addresses.length === 0) return {};
  const lower = addresses.map((a) => a.toLowerCase());
  const url =
    `${this.baseUrl}/simple/token_price/${encodeURIComponent(platform)}` +
    `?contract_addresses=${lower.join(',')}&vs_currencies=usd`;
  const res = await fetch(url, {
    headers: { 'x-cg-demo-api-key': this.apiKey, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Coingecko request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Record<string, { usd?: number }>;
  const out: Record<string, number> = {};
  for (const addr of lower) {
    const price = body[addr]?.usd;
    if (typeof price === 'number') out[addr] = price;
  }
  return out;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/providers/coingecko/coingecko-service.ts
git commit -m "feat(coingecko): add fetchTokenPricesByContract for batch contract-address price lookup"
```

---

### Task 2: Add Unichain Coingecko platform constant

**Files:**
- Modify: `src/constants/unichain.ts`

- [ ] **Step 1: Add constant**

Append to `src/constants/unichain.ts`:

```typescript
export const UNICHAIN_COINGECKO_PLATFORM = 'unichain';
```

- [ ] **Step 2: Commit**

```bash
git add src/constants/unichain.ts
git commit -m "feat(constants): add UNICHAIN_COINGECKO_PLATFORM"
```

---

### Task 3: Add Token domain type

**Files:**
- Modify: `src/database/types.ts`

- [ ] **Step 1: Append Token interface to types.ts**

Add this after the existing types (e.g., after `MemoryEntry`):

```typescript
export interface Token {
  id: number;
  chainId: number;
  chain: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri: string | null;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/database/types.ts
git commit -m "feat(types): add Token domain type"
```

---

### Task 4: Create TokenRepository interface

**Files:**
- Create: `src/database/repositories/token-repository.ts`

- [ ] **Step 1: Write the interface**

Create file with:

```typescript
import type { Token } from '../types';

export interface TokenRepository {
  listByChainId(chainId: number): Promise<Token[]>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/database/repositories/token-repository.ts
git commit -m "feat(database): add TokenRepository interface"
```

---

### Task 5: Implement PrismaTokenRepository

**Files:**
- Create: `src/database/prisma-database/prisma-token-repository.ts`

- [ ] **Step 1: Read an existing repo to confirm pattern**

Read `src/database/prisma-database/prisma-user-wallet-repository.ts` to confirm the import path and mapper pattern.

- [ ] **Step 2: Write the impl**

Create file with:

```typescript
import type { PrismaClient, Token as PrismaToken } from '@prisma/client';
import type { TokenRepository } from '../repositories/token-repository';
import type { Token } from '../types';

function mapToken(row: PrismaToken): Token {
  return {
    id: row.id,
    chainId: row.chainId,
    chain: row.chain,
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    logoUri: row.logoUri,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class PrismaTokenRepository implements TokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByChainId(chainId: number): Promise<Token[]> {
    const rows = await this.prisma.token.findMany({
      where: { chainId },
      orderBy: { symbol: 'asc' },
    });
    return rows.map(mapToken);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/database/prisma-database/prisma-token-repository.ts
git commit -m "feat(database): add PrismaTokenRepository"
```

---

### Task 6: Wire TokenRepository into Database

**Files:**
- Modify: `src/database/database.ts`
- Modify: `src/database/prisma-database/prisma-database.ts`

- [ ] **Step 1: Add `tokens` to the Database interface**

In `src/database/database.ts`, add the import and the field:

```typescript
import type { TokenRepository } from './repositories/token-repository';
```

In the `Database` interface body, add:

```typescript
readonly tokens: TokenRepository;
```

- [ ] **Step 2: Wire it in PrismaDatabase**

In `src/database/prisma-database/prisma-database.ts`:

Add import:
```typescript
import { PrismaTokenRepository } from './prisma-token-repository';
import type { TokenRepository } from '../repositories/token-repository';
```

Add field declaration alongside others (e.g., near `userWallets`):
```typescript
readonly tokens: TokenRepository;
```

In the constructor, add:
```typescript
this.tokens = new PrismaTokenRepository(prisma);
```

- [ ] **Step 3: Commit**

```bash
git add src/database/database.ts src/database/prisma-database/prisma-database.ts
git commit -m "feat(database): wire TokenRepository into Database facade"
```

---

### Task 7: Seed USDC + UNI tokens for Unichain

**Files:**
- Modify: `prisma/seed.ts`

- [ ] **Step 1: Read prisma/seed.ts to find seed pattern**

Look for existing `prisma.<model>.upsert` or `create` calls.

- [ ] **Step 2: Add token seeding**

Add this block in `seed.ts` (use `upsert` so re-running is idempotent). Place it before any return/exit:

```typescript
const unichainTokens = [
  {
    chainId: 130,
    chain: 'unichain',
    address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logoUri: null,
  },
  {
    chainId: 130,
    chain: 'unichain',
    address: '0x8f187aA05619a017077f5308904739877ce9eA21',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    logoUri: null,
  },
];

for (const t of unichainTokens) {
  await prisma.token.upsert({
    where: { address_chainId: { address: t.address, chainId: t.chainId } },
    update: {
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      chain: t.chain,
      logoUri: t.logoUri,
    },
    create: t,
  });
}
console.log(`[seed] upserted ${unichainTokens.length} Unichain tokens`);
```

- [ ] **Step 3: Run the seed**

```bash
npm run db:seed
```

Expected output includes: `[seed] upserted 2 Unichain tokens`.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat(seed): seed USDC + UNI tokens on Unichain"
```

---

### Task 8: Add `fetchTokenBalancesOnUnichain` to BalanceService

**Files:**
- Modify: `src/balance/balance-service.ts`

- [ ] **Step 1: Read current BalanceService**

Confirm `unichainClient` is created via `createPublicClient({ chain: unichain, transport: http(unichainRpc) })` and that viem version supports `multicall`.

- [ ] **Step 2: Add input/output types and the method**

In `src/balance/balance-service.ts`, add this exported interface near the top (after `WalletBalances`):

```typescript
export interface TokenForBalance {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  chainId: number;
}

export interface TokenBalanceItem {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  raw: string;
  formatted: string;
}
```

Add this method to the `BalanceService` class:

```typescript
async fetchTokenBalancesOnUnichain(
  wallet: `0x${string}`,
  tokens: TokenForBalance[],
): Promise<TokenBalanceItem[]> {
  if (tokens.length === 0) return [];
  const results = await this.unichainClient.multicall({
    contracts: tokens.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [wallet] as const,
    })),
    allowFailure: true,
  });
  return tokens.map((t, i) => {
    const r = results[i];
    const raw = r.status === 'success' ? (r.result as bigint) : 0n;
    return {
      chainId: t.chainId,
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      raw: raw.toString(),
      formatted: formatTokenAmount(raw, t.decimals),
    };
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/balance/balance-service.ts
git commit -m "feat(balance): add fetchTokenBalancesOnUnichain via viem multicall"
```

---

### Task 9: Update zerog router to enrich response with tokens + prices

**Files:**
- Modify: `src/api-server/routes/zerog.ts`

- [ ] **Step 1: Replace router contents**

Replace the entire content of `src/api-server/routes/zerog.ts` with:

```typescript
import { Router } from 'express';
import type { Database } from '../../database/database';
import type { BalanceService, TokenBalanceItem, TokenForBalance } from '../../balance/balance-service';
import type { ZeroGBrokerService } from '../../ai/zerog-broker/zerog-broker-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { ZeroGBalancesService } from '../../zerog/zerog-balances-service';
import { UNICHAIN, UNICHAIN_COINGECKO_PLATFORM } from '../../constants';

interface Deps {
  db: Database;
  balanceService: BalanceService;
  brokerService: ZeroGBrokerService;
  coingecko: CoingeckoService;
}

export function buildZeroGRouter(deps: Deps): Router {
  const r = Router();

  r.get('/balances', async (req, res, next) => {
    try {
      const user = req.user!;
      const userWallet = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (!userWallet) {
        res.status(400).json({ error: 'no_wallet', message: 'Provision a wallet first via POST /users/me/wallets' });
        return;
      }

      const wallet = userWallet.walletAddress as `0x${string}`;
      const dbTokens = await deps.db.tokens.listByChainId(UNICHAIN.chainId);
      const tokensForBalance: TokenForBalance[] = dbTokens.map((t) => ({
        address: t.address as `0x${string}`,
        symbol: t.symbol,
        decimals: t.decimals,
        chainId: t.chainId,
      }));

      const balancesService = new ZeroGBalancesService(deps.brokerService);

      const [balancesSnapshot, walletBalances, tokenBalances, tokenPrices] = await Promise.all([
        balancesService.fetchBalancesSnapshot(),
        deps.balanceService.fetchWalletBalances(wallet),
        deps.balanceService.fetchTokenBalancesOnUnichain(wallet, tokensForBalance),
        deps.coingecko.fetchTokenPricesByContract(
          UNICHAIN_COINGECKO_PLATFORM,
          tokensForBalance.map((t) => t.address),
        ),
      ]);

      const enrichedTokens = tokenBalances.map((b: TokenBalanceItem) => {
        const priceUsd = tokenPrices[b.address.toLowerCase()] ?? 0;
        const valueUsd = parseFloat(b.formatted) * priceUsd;
        return {
          chainId: b.chainId,
          address: b.address,
          symbol: b.symbol,
          decimals: b.decimals,
          balanceRaw: b.raw,
          balanceFormatted: b.formatted,
          priceUsd,
          valueUsd: Math.round(valueUsd * 1e6) / 1e6,
        };
      });

      res.json({
        providers: balancesSnapshot.providers,
        ledger: balancesSnapshot.ledger,
        onChainOG: {
          raw: walletBalances.ogOnZerog.raw,
          formatted: walletBalances.ogOnZerog.formatted,
          priceUsd: walletBalances.ogOnZerog.priceUsd,
          valueUsd: walletBalances.ogOnZerog.valueUsd,
        },
        tokens: enrichedTokens,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api-server/routes/zerog.ts
git commit -m "feat(api): enrich /users/me/zerog/balances with token balances + USD prices"
```

---

### Task 10: Update OpenAPI schemas

**Files:**
- Modify: `src/api-server/openapi/schemas.ts`

- [ ] **Step 1: Add new schemas + update response**

Find the `ZeroGBalancesResponseSchema` block (last in the file) and replace it with:

```typescript
export const TokenBalanceWithPriceSchema = z.object({
  chainId: z.number().int(),
  address: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
  balanceRaw: z.string(),
  balanceFormatted: z.string(),
  priceUsd: z.number(),
  valueUsd: z.number(),
}).openapi('TokenBalanceWithPrice');

export const OnChainOGBalanceSchema = z.object({
  raw: z.string(),
  formatted: z.string(),
  priceUsd: z.number(),
  valueUsd: z.number(),
}).openapi('OnChainOGBalance');

export const ZeroGBalancesResponseSchema = z.object({
  providers: z.array(ProviderBalanceSchema),
  ledger: LedgerBalanceSchema,
  onChainOG: OnChainOGBalanceSchema,
  tokens: z.array(TokenBalanceWithPriceSchema),
}).openapi('ZeroGBalancesResponse');
```

- [ ] **Step 2: Commit**

```bash
git add src/api-server/openapi/schemas.ts
git commit -m "docs(openapi): add TokenBalanceWithPrice + OnChainOGBalance schemas"
```

---

### Task 11: Wire Coingecko into ApiServer + zerog router

**Files:**
- Modify: `src/api-server/server.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Update ApiServerDeps and router wiring**

In `src/api-server/server.ts`:

Add import:
```typescript
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
```

In `ApiServerDeps`, add:
```typescript
coingecko: CoingeckoService;
```

Find where the zerog router is mounted (`this.app.use('/users/me/zerog', ...)`) and update the deps object:
```typescript
this.app.use('/users/me/zerog', buildZeroGRouter({
  db: deps.db,
  balanceService: deps.balanceService,
  brokerService: deps.brokerService,
  coingecko: deps.coingecko,
}));
```

- [ ] **Step 2: Pass coingecko in src/server.ts**

The `coingecko` instance already exists in `src/server.ts` (`const coingecko = new CoingeckoService(...)` near `balanceService`). In the `new ApiServer({ ... })` block, add `coingecko,` next to `balanceService,`.

- [ ] **Step 3: Commit**

```bash
git add src/api-server/server.ts src/server.ts
git commit -m "feat(api): wire CoingeckoService into ApiServer for zerog router"
```

---

### Task 12: Verify build and run server

**Files:**
- None (verification only)

- [ ] **Step 1: Run TypeScript build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 2: Run the server**

In a separate shell:
```bash
npm run db:up
npm run db:migrate
npm run db:seed
npm run start:server
```

Expected: server logs `listening on http://localhost:3000`.

- [ ] **Step 3: Hit the endpoint unauthenticated**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/users/me/zerog/balances
```

Expected: `401`.

- [ ] **Step 4: Verify the OpenAPI spec contains new schemas**

```bash
curl -s http://localhost:3000/openapi.json | python3 -c 'import sys,json; s=json.load(sys.stdin)["components"]["schemas"]; print([k for k in s if k in ("TokenBalanceWithPrice","OnChainOGBalance","ZeroGBalancesResponse")])'
```

Expected: `['TokenBalanceWithPrice', 'OnChainOGBalance', 'ZeroGBalancesResponse']` (order may vary).

- [ ] **Step 5: Stop the server**

```bash
npm run db:down
```

- [ ] **Step 6: Commit any remaining state**

```bash
git status
```

If clean, done. If anything new is staged, commit it with a descriptive message.

---

## Summary

This plan extends the existing `/users/me/zerog/balances` endpoint with two additions:

1. **Token balances on Unichain with USD prices.** Uses `Token` rows already modeled in Prisma (seeded with USDC + UNI), fetches balances via viem multicall, and prices via Coingecko's `/simple/token_price/unichain?contract_addresses=...` (one call for all tokens, no `coingeckoId` field needed).

2. **0G price + USD value.** Surfaces the existing `priceUsd`/`valueUsd` from `BalanceService.fetchWalletBalances` (which already calls Coingecko for 0G) under a new `onChainOG` object.

All schema changes flow through OpenAPI registration; no migration is required (the `Token` table already exists).
