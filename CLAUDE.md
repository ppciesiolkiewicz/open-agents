# Project: AI Agent Loop

TypeScript looper. Fires AI agents on schedule. Each agent runs Langchain prompt with onchain (Uniswap v4 / Unichain) + offchain tools. Persists configs, transactions, positions, memory, and the activity log to Postgres (Prisma; Docker locally, Supabase in prod).

Full design: [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md)

## Stack

- TypeScript everywhere
- 0G chain — AI inference, OpenAI-compatible at `<service_url>/v1/proxy`. SDK `@0glabs/0g-serving-broker` for one-time bootstrap. Mainnet RPC `https://evmrpc.0g.ai` (chainId 16661), Galileo testnet RPC `https://evmrpc-testnet.0g.ai` (chainId 16602). Same `WALLET_PRIVATE_KEY` funds the broker (must hold 0G on chosen network). RPCs + chainIds in `constants/`
- Langchain — agent + tool framework. `ChatOpenAI` pointed at 0G proxy
- Uniswap v4 — swaps + quotes
- viem — EVM client
- Alchemy — primary RPC for Unichain (URL derived from `ALCHEMY_API_KEY`); `UNICHAIN_RPC_URL` overrides
- Default chain: **Unichain** (always from `constants/`, never inline `chainId`)

## Coding Standards

### Modules = classes

All modules are classes. Static factory methods when stateless; instances when holding deps. No bare-function modules.

### Function naming

Verb + what + qualifier. Names describe action.

- ✓ `fetchTokenPriceFromCoingecko(symbol)`, `executeUniswapSwapExactIn(...)`, `loadAgentMemoryFromDisk(agentId)`
- ✗ `get`, `do`, `swap`, `load`

### TypeScript

- bigints serialized as **strings** in all JSON
- env validated via `zod` in `config/`
- DB schemas defined in TS interfaces (see spec)

### .env.example stays in sync with `config/env.ts`

Every change to the zod env schema MUST update `.env.example` in the same commit. New required vars get a placeholder line; new optional vars get a commented-out hint with the default behavior. Operators copy `.env.example` → `.env` on first clone — drift breaks onboarding silently.

### OpenAPI spec stays in sync with API routes

Every new HTTP route, every change to a request/response shape, and every change to status codes MUST be reflected in the OpenAPI spec in the same commit. There is no auto-discovery from Express — paths are registered manually in `src/api-server/openapi/spec-builder.ts` against zod schemas defined in `src/api-server/openapi/schemas.ts`. Drift means the generated spec lies to clients silently.

Checklist when adding/changing a route:
1. Add request/response zod schemas to `schemas.ts` with `.openapi('Name')`
2. Import them in `spec-builder.ts`
3. Add a `registry.registerPath({ method, path, request, responses })` block — one response entry per status code the route can return (incl. error cases routed through middleware)

### Constants module

Single source for chain config (Unichain + 0G mainnet/testnet), token addresses, Uniswap fee tiers, worker tick interval. Never inline addresses, chainIds, RPC URLs, or magic numbers like polling intervals.

**Pool addresses + state are NOT constants.** `UniswapService` derives the v4 PoolKey + on-chain pool address + state from `(tokenA, tokenB, feeTier)` at runtime. `constants/` holds the `FeeTier` type (500 | 3_000 | 10_000 bps). Discovery helpers (`buildPoolKey`, `getPoolAddress`, `getPoolState`) live in the `uniswap/` module.

### No comments

Default: write none. Only when WHY is non-obvious (constraint, invariant, workaround).

## Architectural Decisions

### Modular DDD

Split by domain. Each module has one purpose, well-defined interface, testable in isolation.

```
src/
  agent-worker/         tick scheduler, orchestrator, dispatcher
  agent-runner/         single-tick execution (callable, worker-ready)
  ai/
    zerog-broker/       0G bootstrap (provider, fund subaccount, secret)
    chat-model/         Langchain ChatOpenAI factory targeting 0G proxy
  ai-tools/             ToolRegistry — wraps modules below as Langchain tools
  uniswap/              quotes + swap execution (v4)
  wallet/
    real/               viem signer wallet
    dry-run/            ledger-backed mock wallet (same interface)
    factory/            picks impl per agent based on dryRun flag
  providers/
    coingecko/
    coinmarketcap/
    serper/
    firecrawl/
  database/             Database facade + repositories + AgentActivityLog
    repositories/       interfaces (Agent, Transaction, Position, AgentMemory, ActivityLog)
    prisma-database/    PrismaDatabase impl + mappers
    activity-bus.ts        ActivityBus interface (InMemoryActivityBus impl)
    agent-activity-log.ts  facade — writes to repo + publishes to ActivityBus
    types.ts            domain types (incl. AgentActivityLogEntry)
  constants/            chain config, token addresses, pool keys
  redis/                RedisClient factory, RedisTickQueue, RedisActivityBus
  config/               env loader + zod validation
  worker.ts             bootstrap → worker process entry
  server.ts             bootstrap → server process entry
prisma/
  schema.prisma         Postgres schema
  migrations/           Prisma-generated SQL
  seed.ts               installs seed UNI MA trader
docker-compose.yml      local Postgres 16 + Redis 7 services
docker/postgres-init/   first-boot SQL (creates agent_loop_test DB)
```

### Two-process architecture

Two processes share Postgres + Redis. The worker runs the scheduler, orchestrator, and `TickDispatcher`. The server runs the HTTP API. `AgentRunner.run()` is called from `TickDispatcher` in the worker process.

### Scheduler gate logic

Skip backlog. If N intervals missed (downtime), execute **once**, not N times. Update `lastTickAt = now` after run.

### Database = storage-agnostic facade, Prisma + Postgres

`Database` is a composition of repositories (`AgentRepository`, `TransactionRepository`, `PositionRepository`, `AgentMemoryRepository`, `ActivityLogRepository`) — no SQL, paths, or storage primitives leak through the interface. Domain types stay storage-agnostic.

v1 backend = `PrismaDatabase` against Postgres 16 (Docker locally; Supabase in production). Activity log lives in the same DB as structured state — the file-shaped justification for keeping it in its own module disappeared once both stores became SQL.

Local dev:
- `npm run db:up` / `db:down` / `db:nuke` — Docker Compose lifecycle
- `npm run db:migrate` — apply Prisma migrations
- `npm run db:seed` — install the seed UNI MA trader agent
- `npm run db:reset` — wipe data, re-migrate, re-seed
- `npm run db:studio` — open Prisma Studio

`zerog-bootstrap.json` (0G provider state) stays in `./db/` as a file — it is a singleton paid asset (3 OG to recreate) that gets its own migration cycle in a future spec.

Schema in `prisma/schema.prisma`. Tests against a separate `agent_loop_test` database controlled by `TEST_DATABASE_URL`; DB live tests require `TEST_DATABASE_URL` to be set and will fail loudly if it is absent.

### Users + auth

`User` rows are keyed by Privy DID; `UserWallet` is 1:N to `User` with `isPrimary` flagging the default wallet. v1 invariant: every User has exactly one `UserWallet`.

API auth middleware verifies the `Authorization: Bearer <privy-jwt>` header via `@privy-io/server-auth`, then upserts the `User` row by DID and attaches it to `req.user`. First-time users hit `POST /users/me/wallets` to provision their primary Privy server wallet.

`Agent.userId` is required and FK-cascades to `User`. Cross-user agent access returns 404 (not 403) to avoid leaking agent existence.

`WalletFactory.forAgent` returns the operator-funded env-key `RealWallet` regardless of which user owns the agent. Per-user Privy wallets ship in a follow-up cutover spec; the `src/wallet/privy/` module is fully built and live-tested in preparation. The worker process runs without Privy credentials; the server process requires `PRIVY_APP_ID` + `PRIVY_APP_SECRET`.

### Wallet abstraction

Single `Wallet` interface. Two impls:

- `RealWallet` — viem signer from `WALLET_PRIVATE_KEY`
- `DryRunWallet` — same interface, ledger from dry-run Transactions (identified by sentinel hash)
- `WalletFactory.forAgent(config)` picks based on `agent.dryRun`

### Dry-run is a wiring concern

Agent **never knows** it's dry-run. Same tool surface, same return shapes. Same `Transaction` row shape.

Dry-run swaps are minted with a **sentinel hash pattern**: `0x` + 60 zeros + 4 hex chars (counter suffix for uniqueness). This is **documentation, not a runtime filter** — operators clear the DB between dry-run and real-run sessions, so within a session every tx belongs to the active mode by construction. `generateDryRunHash()` lives in `wallet/dry-run/`.

Other Transaction fields for dry-run: `gasUsed`/`gasPriceWei`/`gasCostWei` use estimated values (real-time gas price × typical swap gas) so dry-run cost accounting matches reality; `blockNumber: null`; `status: 'success'`. `tokenIn`/`tokenOut` are quote-derived. Wallets compute dry-run balances by replaying these rows against the seed.

### Position–Transaction relationship

`Position.openedByTransactionId` and `Position.closedByTransactionId` reference the originating swaps. `Position.amount` is a `TokenAmount` (token + amount), not loose fields. P&L is traceable end-to-end: position → opening tx → closing tx.

### Risk limits per-agent, extensible

`agent.riskLimits = { maxTradeUSD, ... }`. Enforced in `ai-tools` swap wrapper before calling `UniswapService`. v1 only `maxTradeUSD`; structure permits adding `maxSlippageBps`, daily caps, cooldowns later.

### Tools = all-on for v1

Every agent gets every tool. Per-agent allowlist deferred until manual experimentation done.

### Comprehensive logging

Every tick, every tool call, every LLM call/response, every memory update → JSON log entry. Designed for later UI render.

### Testing — anything that spends money lives in `scripts/`

**Tests live only for modules that talk to an external system** (provider HTTP, blockchain RPC, Redis). Pure-logic modules (env loader, constants, scheduler, factories) get no dedicated tests — they're exercised end-to-end by `npm run start:worker` / `start:server` and downstream integration tests.

- **File suffix:** `*.live.test.ts`.
- **No mocked HTTP, no mocked external services.** Hit the real thing using UNI/USDC on Unichain (read-only RPC reads + provider GET calls).
- Live tests require their dependencies (API keys, Postgres, etc.) to be present — they fail loudly otherwise so missing env never silently hides bugs.
- **Test style:** assert "we got something sensible", then `console.log` the payload so a human can eyeball it. Smoke checks + living usage examples. Avoid brittle assertions on exact response shapes.
- Only acceptable fake: **time** (vitest fake timers), and only when the module has no external dependency.

**Policy:** anything that costs OG, ETH gas, or other paid credits goes in `scripts/`, NOT in `*.live.test.ts`. This way `npm test` never silently burns money no matter how often it runs.

- `npm test` — read-only live tests + unit tests. Runs in CI when keys present.
- `scripts/` — manual one-off operations with explicit y/n prompts via `confirmContinue` from `src/test-lib/interactive-prompt.ts`:
  - `npm run zerog-bootstrap` — list 0G providers, optionally fund a sub-account (3 OG ledger + 1 OG transfer)
  - `npm run llm:probe` — send one trivial inference request through the configured 0G provider (~tiny fee)
  - `npm run swap:buy-uni` — 0.5 USDC → UNI on Unichain (real swap, opens a Position)
  - `npm run swap:sell-uni` — 0.1 UNI → USDC on Unichain (closes most-recent UNI Position)

### Transactions + positions always recorded

Real or dry-run. Token in/out, gas (estimated for dry-run), status, block. Never lose money tracking.

## Slice Order (impl)

1. **Bootstrap** — project setup (package.json, tsconfig, vitest), `.gitignore`, `config/` env loader, `constants/`, all `providers/` with live UNI/USDC tests, empty `agent-worker/` that ticks but loads no agents
2. **Database + activity log** — `database/` (Database facade + repositories + PrismaDatabase + AgentActivityLog)
3. **Wallet** — real + dry-run + factory with tests
4. **Worker + AgentRunner skeleton** (mocked LLM, wires DB + wallet + log)
5. **AI integration** — 0G bootstrap, chat-model, real LLM in runner
6. **AI tools surface** — Langchain wrappers around providers + wallet
7. **Uniswap module + swap tools + risk enforcement**
8. **Seed agent** — UNI MA trader, end-to-end dry-run
9. **Worker/server split** — Redis queue + activity bus, two process entries

Each slice = own implementation plan via writing-plans skill.

## Env

```
# Wallet (used for Unichain trading AND 0G broker funding)
WALLET_PRIVATE_KEY=

# Chain (Unichain)
ALCHEMY_API_KEY=
UNICHAIN_RPC_URL=         # optional override; defaults to Alchemy URL

# 0G chain
ZEROG_NETWORK=testnet     # mainnet | testnet
ZEROG_PROVIDER_ADDRESS=   # optional; bootstrap auto-picks otherwise

# Data providers
COINGECKO_API_KEY=
COINMARKETCAP_API_KEY=
SERPER_API_KEY=
FIRECRAWL_API_KEY=

# Runtime
DB_DIR=./db
LOG_LEVEL=info
# AXL_URL=http://127.0.0.1:9002   # optional; defaults to local AXL node

# Postgres
DATABASE_URL=
TEST_DATABASE_URL=        # optional; live tests skip when absent

# Redis (queue + activity bus)
REDIS_URL=

# Privy (required by the server process)
PRIVY_APP_ID=
PRIVY_APP_SECRET=
```

Service URL, secret, model — discovered at bootstrap, persisted to `./db/zerog-bootstrap.json`. Worker tick interval lives in `constants/`, not env.
