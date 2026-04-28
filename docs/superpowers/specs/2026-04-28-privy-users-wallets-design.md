# Privy Users + Wallet Module — Design

**Date:** 2026-04-28
**Status:** Brainstorming phase
**Scope:** Add `User` + `UserWallet` tables and FK them from `Agent`. Replace the stub auth middleware with Privy JWT verification. Auto-provision a `User` row on first verified DID. Build a `PrivyServerWallet` + `PrivyWalletFactory` module that signs via Privy's server-wallet API. Provide `POST /users/me/wallets` to create a user's primary Privy server wallet. Tighten ownership checks across the API. Drop dead `MODE`-less paths kept for completeness — modes stay as today.

## Goal

Move the project from "single shared env-key wallet, fake stub user" to "real Privy-authenticated users with their own server-custodied wallets." This spec lands the data layer + auth boundary + wallet module, but **does not yet wire the live `WalletFactory.forAgent` to Privy** — the existing env-key `RealWallet` stays the runtime path. That cutover is a follow-up spec; doing both at once doubles the change surface for no shipping benefit. Funds management during dev stays simple: one operator-funded EOA covers every agent.

After this spec:
- A frontend can sign a user in via Privy, send the JWT to our backend, and the backend will create / look up a `User` row keyed by Privy DID.
- The frontend can call `POST /users/me/wallets` once after first login to create that user's primary Privy server wallet.
- Every API endpoint enforces "this agent belongs to this user" via `assertAgentOwnedBy(agent, req.user)`.
- The `wallet/privy/` module is fully built and live-tested against a real Privy dev app, ready to be wired into `WalletFactory.forAgent` in a follow-up.

## Non-Goals (this spec)

- **Switching `WalletFactory.forAgent` over to per-user Privy wallets.** Stays as env-key `RealWallet`. Follow-up spec.
- **Multi-wallet per user at runtime.** The `UserWallet` table supports it, but v1 invariant is: every `User` has exactly one `UserWallet`, marked `isPrimary: true`.
- **`Agent.walletId` FK** to pick a non-primary wallet. Future when multi-wallet lands.
- **Per-user funding flows / deposit address surfacing.** Out of scope; the operator funds the env-key wallet today.
- **Frontend integration.** This repo is backend-only; the Privy SDK on the client is the consumer's problem.
- **API route integration tests against a live Express server.** Existing repo has no such tests; not in scope to start.
- **Curl-friendly dev mode that bypasses Privy.** Operators must provision a Privy app before running with `MODE=server` or `MODE=both`. `MODE=looper` works without Privy because the looper does not hit auth middleware.
- **Multiple chain/key types per wallet.** Privy server wallets default to EVM EOAs on Unichain via the Privy API; that is enough for v1.

## Decisions

### D1. Two new tables: `User` and `UserWallet` (1:N)

`User` is the identity row keyed by `privyDid`. `UserWallet` is one row per managed wallet, with `isPrimary` flagging the one used by default. Splitting wallets into their own table now (instead of inlining `privyServerWalletId`/`walletAddress` on `User`) means the multi-wallet future is purely additive: more rows, no schema migration.

### D2. `Agent.userId` is `NOT NULL` from day one

The dev DB is throwaway and we have been resetting it freely. Forcing `userId` on `Agent` from the start avoids the null-handling tax across ownership checks. The migration drops existing rows; the seed script (`prisma/seed.ts`) creates a deterministic dev user first, then assigns the seed agent to that user.

### D3. Auth middleware verifies JWT + upserts `User` only — no Privy wallet calls

The Privy server-wallet API is an external HTTP call with its own latency and failure modes. Tangling it into the auth path makes login slow on first request and breaks identity when Privy's wallet service is degraded. Middleware stays cheap: verify JWT (`@privy-io/server-auth` SDK), extract DID, `db.users.findOrCreateByPrivyDid(did, claims)`, attach to `req.user`. Done.

### D4. Wallet provisioning lives behind an explicit `POST /users/me/wallets` endpoint

The frontend calls it once after first login. Endpoint is idempotent: if the user already has a primary wallet, returns 200 with the existing one. Failure leaves no half-state — no `UserWallet` row is inserted unless the Privy API call succeeded. Endpoints that need a wallet (none in this spec; reserved for future) return 409 `wallet_not_provisioned` if missing, signaling the frontend to call this endpoint.

### D5. `wallet/privy/` is built but not wired

`PrivyServerWallet` implements the existing `Wallet` interface (`getAddress`, `getNativeBalance`, `getTokenBalance`, `signAndSendTransaction`) by calling Privy's server-wallet SDK. `PrivyWalletFactory.forUserWallet(uw)` constructs one for a specific `UserWallet` row. The class is fully unit/live-tested. `WalletFactory.forAgent` keeps returning the env-key `RealWallet` regardless of which user owns the agent — a comment in the factory marks the cutover as a follow-up spec.

### D6. `MODE` env stays (`looper` | `server` | `both`)

`MODE=looper` runs without Privy credentials — the looper never touches auth. `MODE=server` and `MODE=both` require `PRIVY_APP_ID` + `PRIVY_APP_SECRET`; bootstrap fails fast if missing.

### D7. JWT verification via `@privy-io/server-auth`

The SDK handles JWKS fetching + signature verification. We do not roll our own JWT parsing. The SDK's `verifyAuthToken(token)` returns the user's DID and claims; we trust the SDK's algorithm choice (RS256 / ES256 — Privy issues both depending on app config).

### D8. Ownership invariants

- `Agent.userId` is required.
- `Transaction.agentId → Agent.id` (already enforced by Postgres FK + `onDelete: Cascade`).
- `Position.agentId → Agent.id` (same).
- `AgentMemory.agentId → Agent.id` (same).
- `ActivityEvent.agentId → Agent.id` (same).
- API ownership is checked at the agent level: `assertAgentOwnedBy(agent, user)` throws `ForbiddenError` if `agent.userId !== user.id`. All transitive resources inherit ownership through their agent FK.
- Cross-user enumeration is blocked at list endpoints by filtering on `userId` in the `where` clause.

### D9. Schema (Prisma)

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

model Agent {
  // ... existing fields ...
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

### D10. Repositories

Two new repository interfaces in `src/database/repositories/`:

```typescript
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByPrivyDid(privyDid: string): Promise<User | null>;
  findOrCreateByPrivyDid(privyDid: string, claims: { email?: string }): Promise<User>;
}

export interface UserWalletRepository {
  insert(uw: UserWallet): Promise<void>;
  findById(id: string): Promise<UserWallet | null>;
  findPrimaryByUser(userId: string): Promise<UserWallet | null>;
  listByUser(userId: string): Promise<UserWallet[]>;
  findByPrivyWalletId(privyWalletId: string): Promise<UserWallet | null>;
}
```

`Database` interface gains `users` and `userWallets`. `PrismaDatabase` composes the new Prisma impls.

### D11. Domain types

`src/database/types.ts`:

```typescript
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

### D12. API auth middleware

`src/api-server/auth/privy-auth.ts`:

```typescript
export class PrivyAuth {
  constructor(private readonly client: PrivyClient) {}

  async verifyToken(bearer: string): Promise<{ did: string; email?: string }> {
    const claims = await this.client.verifyAuthToken(bearer);
    return { did: claims.userId, email: claims.email as string | undefined };
  }
}
```

`src/api-server/middleware/auth.ts` becomes:

```typescript
export function buildAuthMiddleware(privyAuth: PrivyAuth, users: UserRepository) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'invalid_token' });
    try {
      const { did, email } = await privyAuth.verifyToken(header.slice(7));
      const user = await users.findOrCreateByPrivyDid(did, { email });
      req.user = user;
      next();
    } catch (err) {
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}
```

`req.user` becomes the full `User` domain object (was `{ id: string }` stub). `assertAgentOwnedBy` becomes a real check: `if (agent.userId !== user.id) throw new ForbiddenError()`.

### D13. Wallet provisioner + endpoint

`src/wallet/privy/wallet-provisioner.ts`:

```typescript
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

`src/api-server/routes/users.ts`:

- `GET /users/me` → returns `{ user, wallets: UserWallet[] }`.
- `POST /users/me/wallets` → calls `walletProvisioner.provisionPrimary(req.user.id)`. Returns `201` if newly created, `200` if existing. Body: `{ id, walletAddress, isPrimary }`.

### D14. `PrivyServerWallet` + `PrivyWalletFactory`

`src/wallet/privy/privy-server-wallet.ts`:

```typescript
export class PrivyServerWallet implements Wallet {
  constructor(
    private readonly privy: PrivyClient,
    private readonly userWallet: UserWallet,
    private readonly viemPublicClient: PublicClient,
  ) {}

  getAddress(): `0x${string}` { return this.userWallet.walletAddress as `0x${string}`; }

  getNativeBalance(): Promise<bigint> {
    return this.viemPublicClient.getBalance({ address: this.getAddress() });
  }

  getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint> {
    // Same ERC20 read path as RealWallet — viem readContract on `balanceOf`.
  }

  async signAndSendTransaction(req: TxRequest): Promise<TransactionReceipt> {
    const { hash } = await this.privy.walletApi.sendTransaction({
      walletId: this.userWallet.privyWalletId,
      caip2: 'eip155:130',  // Unichain
      transaction: { to: req.to, data: req.data, value: req.value, gas: req.gas },
    });
    return await this.viemPublicClient.waitForTransactionReceipt({ hash });
  }
}
```

`src/wallet/privy/privy-wallet-factory.ts`:

```typescript
export class PrivyWalletFactory {
  constructor(
    private readonly privy: PrivyClient,
    private readonly viemPublicClient: PublicClient,
  ) {}

  forUserWallet(uw: UserWallet): Wallet {
    return new PrivyServerWallet(this.privy, uw, this.viemPublicClient);
  }
}
```

`WalletFactory` (in `src/wallet/factory/wallet-factory.ts`) is unchanged. A comment marks the cutover as deferred:

```typescript
/**
 * Transitional: returns the env-key RealWallet for every agent regardless
 * of which user owns it. Per-user wallets via PrivyWalletFactory ship in
 * a follow-up spec — the module exists and is tested but not wired here.
 */
```

### D15. Env

`src/config/env.ts` gains:

```typescript
PRIVY_APP_ID: z.string().min(1).optional(),
PRIVY_APP_SECRET: z.string().min(1).optional(),
```

These are `optional()` because `MODE=looper` does not need them. Bootstrap (in `src/index.ts`) refines: if `MODE` includes `server` and either is missing, `console.error` + `process.exit(1)`.

`.env.example` adds:

```
# Privy (required when MODE=server or MODE=both)
PRIVY_APP_ID=
PRIVY_APP_SECRET=
```

### D16. Bootstrap wiring

`src/index.ts`:

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
}

if (runServer) {
  api = new ApiServer({
    db, activityLog, runner, queue,
    privyAuth: privyAuth!,
    walletProvisioner: walletProvisioner!,
    port: env.PORT,
    ...(env.API_CORS_ORIGINS ? { corsOrigins: env.API_CORS_ORIGINS } : {}),
  });
  await api.start();
}
```

The looper / agent runner does NOT receive a Privy client. Privy is purely an API-server-time concern in this spec.

### D17. Migration strategy

Single Prisma migration: `<ts>_add_users_userwallets`. Adds `User` + `UserWallet` tables, then adds `Agent.userId` as `NOT NULL`. Because `Agent.userId` is required, the auto-generated migration will fail-loud if `Agent` is non-empty — this is intentional. Operators run `npm run db:reset` to start fresh.

Manual migration tweak: prisma will likely emit `ALTER TABLE "Agent" ADD COLUMN "userId" TEXT NOT NULL` which only works on an empty table. That's our v1 reality (dev DB only). For a future production migration this would need a backfill phase; documented as a follow-up if/when prod data ever exists.

### D18. Seed script changes

`prisma/seed.ts`:

```typescript
const DEV_USER_DID = 'did:privy:dev-local';
const DEV_USER_ID = 'user-dev-local';
const SEED_AGENT_USER_ID = DEV_USER_ID;

// 1. Create dev User row (no wallet — dev runs with MODE=looper or wires
//    PRIVY_APP_* before MODE=server). The seed agent uses the env-key
//    wallet via the transitional WalletFactory; nothing about the seed
//    needs Privy at install time.
await db.users.findOrCreateByPrivyDid(DEV_USER_DID, { email: 'dev@local' });

// 2. Existing seed-agent install path, with userId attached.
const seed = buildSeedAgentConfig({ dryRun, userId: DEV_USER_ID });
await db.agents.upsert(seed);
```

`scripts/lib/seed-uni-ma-trader.ts` gains a required `userId` field on the produced `AgentConfig`.

## Data Flow

**Authed request:**
```
HTTP → cors → auth middleware
                ├─ verify Bearer token via PrivyAuth
                ├─ findOrCreateByPrivyDid(did, claims) → User row
                └─ req.user = User
              → route handler
                ├─ assertAgentOwnedBy(agent, req.user)
                └─ ...
```

**Wallet provisioning (one-time per user):**
```
POST /users/me/wallets
  → walletProvisioner.provisionPrimary(req.user.id)
  ├─ if existing primary: return 200 { existing }
  ├─ else: privy.walletApi.create({ chainType: 'ethereum' }) → { id, address }
  └─ db.userWallets.insert({ ..., isPrimary: true }) → 201 { uw }
```

**Looper / agent tick:** Unchanged. `walletFactory.forAgent(agent)` → env-key `RealWallet`. Agent's `userId` field exists in the DB but the runtime doesn't read it.

## File Layout

```
prisma/
  schema.prisma                                  + User, UserWallet; Agent.userId
  migrations/<ts>_add_users_userwallets/
    migration.sql                                auto-generated
  seed.ts                                        creates dev User first, then agent

src/
  config/
    env.ts                                       + PRIVY_APP_ID, PRIVY_APP_SECRET (optional, refined at bootstrap)

  database/
    types.ts                                     + User, UserWallet
    database.ts                                  + users, userWallets fields
    repositories/
      user-repository.ts                         NEW
      user-wallet-repository.ts                  NEW
    prisma-database/
      prisma-user-repository.ts                  NEW
      prisma-user-wallet-repository.ts           NEW
      prisma-database.ts                         + composes both
      mappers.ts                                 + user/userWallet mappers
      prisma-database.live.test.ts               + user + userWallet round-trip tests

  api-server/
    auth/                                        NEW directory
      privy-auth.ts                              JWT verification wrapper
      privy-auth.live.test.ts                    skip when PRIVY_APP_* missing
    middleware/
      auth.ts                                    Privy verification + upsert User; req.user typed as User
    routes/
      users.ts                                   NEW: GET /users/me, POST /users/me/wallets
      agents.ts                                  ownership: filter list by userId; assert on get/update/delete
      activity.ts                                ownership: assert on agentId param
      messages.ts                                ownership: assert on agentId param
      stream.ts                                  ownership: assert on agentId param
    server.ts                                    + new dependencies in constructor
    openapi/
      schemas.ts                                 + UserSchema, UserWalletSchema, request/response shapes

  wallet/
    privy/                                       NEW
      privy-server-wallet.ts                     Wallet impl
      privy-wallet-factory.ts                    forUserWallet(uw)
      wallet-provisioner.ts                      provisionPrimary(userId)
      privy-server-wallet.live.test.ts           skip when PRIVY_APP_* missing
      privy-wallet-factory.live.test.ts          skip when PRIVY_APP_* missing
    factory/
      wallet-factory.ts                          UNCHANGED behavior; comment marks cutover as deferred

  index.ts                                       + Privy client + provisioner; refines required env per MODE

scripts/
  lib/
    seed-uni-ma-trader.ts                        + required userId on produced AgentConfig

.env.example                                     + PRIVY_APP_ID, PRIVY_APP_SECRET
```

## Error Handling

| Condition | Status | Body |
|---|---|---|
| No / malformed `Authorization` header | 401 | `{ error: 'invalid_token' }` |
| Privy JWT invalid / expired | 401 | `{ error: 'invalid_token' }` |
| Privy verification service unreachable | 503 | `{ error: 'auth_unavailable' }` |
| Cross-user agent access | 403 | `{ error: 'forbidden' }` |
| Wallet provisioning failure (Privy API error) | 502 | `{ error: 'wallet_provisioning_failed' }` |
| Wallet required but missing | 409 | `{ error: 'wallet_not_provisioned' }` |
| Agent not found (and exists for another user) | 404 | `{ error: 'agent_not_found' }` *(not 403, to avoid leaking existence)* |

## Testing

- `prisma-user-repository.live.test.ts` — `findOrCreateByPrivyDid` is idempotent; second call returns the same row; email update on second call propagates.
- `prisma-user-wallet-repository.live.test.ts` — insert + `findPrimaryByUser` + uniqueness on `privyWalletId`.
- `prisma-database.live.test.ts` — extends existing test for `Agent.userId` round-trip + cascade-delete-on-user.
- `privy-auth.live.test.ts` — verifies a real signed test JWT against the configured Privy dev app. Skips when `PRIVY_APP_*` missing.
- `privy-server-wallet.live.test.ts` — creates a real Privy server wallet on a dev app, reads `walletAddress`, asserts viem balance lookup works. No tx broadcast in v1 (would need funded dev wallet); broadcasts deferred to follow-up cutover spec where the wallet will be the runtime wallet.
- `privy-wallet-factory.live.test.ts` — passes a UserWallet row in, gets a working `Wallet` instance back, verifies `getAddress()` matches.
- API route tests — out of scope.

## Open Items

- **Cutover spec** — switching `WalletFactory.forAgent` over to `PrivyWalletFactory.forUserWallet`, including how an agent picks among multiple wallets (probably `Agent.walletId` FK with default = primary).
- **Multi-wallet runtime** — `POST /users/me/wallets` currently only supports the primary case (idempotent return on second call); a follow-up extends it to insert additional `isPrimary: false` rows.
- **Per-agent / per-user funding** — once Privy wallets are live, operators stop being able to fund a single env-key. Need a deposit-address surface and / or auto-funding from a treasury.
- **Production migration of `Agent.userId`** — current migration assumes empty `Agent` table. A real prod backfill plan (system user, ownership reconciliation) is needed before this design hits prod.
- **API integration tests** — neither the existing API server design nor this one tests routes against a live Express; due for a separate testing-strategy spec.
