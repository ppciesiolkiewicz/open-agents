# Wallet Balances Endpoint Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split balance data into two endpoints: revert `/users/me/zerog/balances` to 0G-only data, and add new `/users/me/wallet/balances` returning per-chain token balances.

**Architecture:** Token-balance logic moves under the existing `BalanceService` (already there), exposed through a new router under `src/api-server/routes/wallet.ts`. The 0G endpoint keeps its existing services but drops the `tokens` field. Response shape uses a `chains` map keyed by lowercase chain slug (`unichain`, future EVM chains).

**Tech Stack:** Express, viem multicall, Coingecko `/simple/token_price/{platform}`, Prisma `Token` table, zod + OpenAPI registry.

---

## Files

- Create: `src/api-server/routes/wallet.ts` — new router for `/users/me/wallet/balances`
- Modify: `src/api-server/routes/zerog.ts` — drop `tokens` + Coingecko + DB token reads; restore `onChainOG` only
- Modify: `src/api-server/openapi/schemas.ts` — replace combined `ZeroGBalancesResponse` with two separate response schemas + `ChainBalance` shape
- Modify: `src/api-server/openapi/spec-builder.ts` — register the new path
- Modify: `src/api-server/server.ts` — wire new router; trim `coingecko` dep from zerog router (still needed for wallet router)

---

### Task 1: Restore zerog router to 0G-only shape

Drop tokens, prices, Coingecko, and the Token DB read from the zerog router. Keep `providers`, `ledger`, `onChainOG`.

**Files:**
- Modify: `src/api-server/routes/zerog.ts`

- [ ] **Step 1: Replace the entire file content**

Overwrite `src/api-server/routes/zerog.ts` with:

```typescript
import { Router } from 'express';
import type { Database } from '../../database/database';
import type { BalanceService } from '../../balance/balance-service';
import type { ZeroGBrokerService } from '../../ai/zerog-broker/zerog-broker-service';
import { ZeroGBalancesService } from '../../zerog/zerog-balances-service';

interface Deps {
  db: Database;
  balanceService: BalanceService;
  brokerService: ZeroGBrokerService;
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
      const balancesService = new ZeroGBalancesService(deps.brokerService);

      const [balancesSnapshot, walletBalances] = await Promise.all([
        balancesService.fetchBalancesSnapshot(),
        deps.balanceService.fetchWalletBalances(wallet),
      ]);

      res.json({
        providers: balancesSnapshot.providers,
        ledger: balancesSnapshot.ledger,
        onChainOG: {
          raw: walletBalances.ogOnZerog.raw,
          formatted: walletBalances.ogOnZerog.formatted,
          priceUsd: walletBalances.ogOnZerog.priceUsd,
          valueUsd: walletBalances.ogOnZerog.valueUsd,
        },
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
git commit -m "refactor(api): zerog/balances returns 0G-only data, drop tokens"
```

---

### Task 2: Create wallet router with chains shape

New endpoint `/users/me/wallet/balances` returning per-chain token balances. Computes per-chain `totalValueUsd` and a top-level `totalValueUsd`.

**Files:**
- Create: `src/api-server/routes/wallet.ts`

- [ ] **Step 1: Write the router**

Create `src/api-server/routes/wallet.ts`:

```typescript
import { Router } from 'express';
import type { Database } from '../../database/database';
import type { BalanceService, TokenBalanceItem, TokenForBalance } from '../../balance/balance-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { UNICHAIN, UNICHAIN_COINGECKO_PLATFORM } from '../../constants';

interface Deps {
  db: Database;
  balanceService: BalanceService;
  coingecko: CoingeckoService;
}

interface TokenWithPrice {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
  balanceFormatted: string;
  priceUsd: number;
  valueUsd: number;
}

interface ChainBalance {
  chainId: number;
  tokens: TokenWithPrice[];
  totalValueUsd: number;
}

export function buildWalletRouter(deps: Deps): Router {
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

      const [tokenBalances, tokenPrices] = await Promise.all([
        deps.balanceService.fetchTokenBalancesOnUnichain(wallet, tokensForBalance),
        deps.coingecko.fetchTokenPricesByContract(
          UNICHAIN_COINGECKO_PLATFORM,
          tokensForBalance.map((t) => t.address),
        ),
      ]);

      const enrichedTokens: TokenWithPrice[] = tokenBalances.map((b: TokenBalanceItem) => {
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

      const unichainTotal = enrichedTokens.reduce((acc, t) => acc + t.valueUsd, 0);

      const unichain: ChainBalance = {
        chainId: UNICHAIN.chainId,
        tokens: enrichedTokens,
        totalValueUsd: Math.round(unichainTotal * 1e6) / 1e6,
      };

      const totalValueUsd = unichain.totalValueUsd;

      res.json({
        chains: { unichain },
        totalValueUsd: Math.round(totalValueUsd * 1e6) / 1e6,
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
git add src/api-server/routes/wallet.ts
git commit -m "feat(api): add GET /users/me/wallet/balances router with chains shape"
```

---

### Task 3: Update OpenAPI schemas

Replace the existing `ZeroGBalancesResponseSchema` (which currently includes `onChainOG` + `tokens`) with two separate shapes: a leaner zerog response and the new wallet response.

**Files:**
- Modify: `src/api-server/openapi/schemas.ts`

- [ ] **Step 1: Locate the block to replace**

Find these schemas at the end of `src/api-server/openapi/schemas.ts`:

```typescript
export const TokenBalanceWithPriceSchema = z.object({ ... }).openapi('TokenBalanceWithPrice');
export const OnChainOGBalanceSchema = z.object({ ... }).openapi('OnChainOGBalance');
export const ZeroGBalancesResponseSchema = z.object({
  providers: z.array(ProviderBalanceSchema),
  ledger: LedgerBalanceSchema,
  onChainOG: OnChainOGBalanceSchema,
  tokens: z.array(TokenBalanceWithPriceSchema),
}).openapi('ZeroGBalancesResponse');
```

- [ ] **Step 2: Replace with new schemas**

Overwrite that block with:

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
}).openapi('ZeroGBalancesResponse');

export const ChainBalanceSchema = z.object({
  chainId: z.number().int(),
  tokens: z.array(TokenBalanceWithPriceSchema),
  totalValueUsd: z.number(),
}).openapi('ChainBalance');

export const WalletBalancesResponseSchema = z.object({
  chains: z.object({
    unichain: ChainBalanceSchema,
  }),
  totalValueUsd: z.number(),
}).openapi('WalletBalancesResponse');
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/openapi/schemas.ts
git commit -m "docs(openapi): drop tokens from ZeroGBalances; add WalletBalances + ChainBalance schemas"
```

---

### Task 4: Register `/users/me/wallet/balances` path

**Files:**
- Modify: `src/api-server/openapi/spec-builder.ts`

- [ ] **Step 1: Read the file**

Read `src/api-server/openapi/spec-builder.ts` to confirm: imports section at top, `registry.registerPath` blocks below. The existing `/users/me/zerog/balances` registration is the model to follow (200/400/401/500).

- [ ] **Step 2: Add the import**

In the imports section, add `WalletBalancesResponseSchema` next to `ZeroGBalancesResponseSchema`:

```typescript
import { ..., ZeroGBalancesResponseSchema, WalletBalancesResponseSchema } from './schemas';
```

(Adjust the named-import list to include both — keep all other imports intact.)

- [ ] **Step 3: Add the registerPath block**

Place it directly after the existing `/users/me/zerog/balances` registration:

```typescript
registry.registerPath({
  method: 'get',
  path: '/users/me/wallet/balances',
  description: 'Get per-chain token balances with USD prices for the authenticated user',
  responses: {
    200: {
      description: 'Success',
      content: { 'application/json': { schema: WalletBalancesResponseSchema } },
    },
    400: {
      description: 'No wallet provisioned',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'invalid or missing token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Server error (RPC timeout, Coingecko unavailable, etc.)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
```

- [ ] **Step 4: Commit**

```bash
git add src/api-server/openapi/spec-builder.ts
git commit -m "docs(openapi): register GET /users/me/wallet/balances"
```

---

### Task 5: Update zerog router deps in ApiServer (drop coingecko) and wire new wallet router

The zerog router no longer needs `coingecko` (Task 1 removed that). The new wallet router does need it.

**Files:**
- Modify: `src/api-server/server.ts`

- [ ] **Step 1: Add wallet router import**

In `src/api-server/server.ts`, add this import (near the other route imports):

```typescript
import { buildWalletRouter } from './routes/wallet';
```

- [ ] **Step 2: Drop coingecko from the zerog router call**

Find the line:

```typescript
this.app.use('/users/me/zerog', buildZeroGRouter({ db: deps.db, balanceService: deps.balanceService, brokerService: deps.brokerService, coingecko: deps.coingecko }));
```

Replace with:

```typescript
this.app.use('/users/me/zerog', buildZeroGRouter({ db: deps.db, balanceService: deps.balanceService, brokerService: deps.brokerService }));
```

- [ ] **Step 3: Mount the wallet router**

Directly after the zerog mount line, add:

```typescript
this.app.use('/users/me/wallet', buildWalletRouter({ db: deps.db, balanceService: deps.balanceService, coingecko: deps.coingecko }));
```

- [ ] **Step 4: Commit**

```bash
git add src/api-server/server.ts
git commit -m "feat(api): mount wallet router; drop coingecko from zerog router deps"
```

---

### Task 6: Verify build + spec

**Files:** none (verification only)

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 2: Restart server**

Kill any running server on port 3000 and start a fresh one from this worktree:

```bash
lsof -ti :3000 | xargs -r kill
sleep 2
npm run start:server &
sleep 3
```

- [ ] **Step 3: Verify both endpoints respond 401 unauthenticated**

```bash
curl -s -o /dev/null -w "zerog: %{http_code}\n" http://localhost:3000/users/me/zerog/balances
curl -s -o /dev/null -w "wallet: %{http_code}\n" http://localhost:3000/users/me/wallet/balances
```

Expected:
```
zerog: 401
wallet: 401
```

- [ ] **Step 4: Verify OpenAPI registers both paths and new schemas**

```bash
curl -s http://localhost:3000/openapi.json | python3 -c '
import sys, json
d = json.load(sys.stdin)
paths = list(d["paths"].keys())
schemas = list(d["components"]["schemas"].keys())
assert "/users/me/zerog/balances" in paths, "missing zerog path"
assert "/users/me/wallet/balances" in paths, "missing wallet path"
for n in ("WalletBalancesResponse", "ChainBalance", "ZeroGBalancesResponse", "TokenBalanceWithPrice", "OnChainOGBalance"):
    assert n in schemas, f"missing schema {n}"
print("OK: both paths + all schemas present")
print("zerog response keys:", list(d["components"]["schemas"]["ZeroGBalancesResponse"]["properties"].keys()))
print("wallet response keys:", list(d["components"]["schemas"]["WalletBalancesResponse"]["properties"].keys()))
'
```

Expected:
- `OK: both paths + all schemas present`
- `zerog response keys: ['providers', 'ledger', 'onChainOG']` (no `tokens`)
- `wallet response keys: ['chains', 'totalValueUsd']`

- [ ] **Step 5: Stop server**

```bash
lsof -ti :3000 | xargs -r kill
```

- [ ] **Step 6: Commit any incidental changes**

```bash
git status
```

If clean, done.

---

## Summary

After this plan:

- **`GET /users/me/zerog/balances`** returns only 0G-relevant data (`providers`, `ledger`, `onChainOG`).
- **`GET /users/me/wallet/balances`** is new and returns:
  ```json
  {
    "chains": {
      "unichain": {
        "chainId": 130,
        "tokens": [...],
        "totalValueUsd": 0
      }
    },
    "totalValueUsd": 0
  }
  ```
- New chains slot in by adding a key under `chains` (lowercase slug) — no shape change required.
- Token-balance logic (`BalanceService.fetchTokenBalancesOnUnichain`, `CoingeckoService.fetchTokenPricesByContract`, `TokenRepository.listByChainId`) is unchanged and shared by the wallet router.
