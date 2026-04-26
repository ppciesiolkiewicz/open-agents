# Project: AI Agent Loop

TypeScript looper. Fires AI agents on schedule. Each agent runs Langchain prompt with onchain (Uniswap v4 / Unichain) + offchain tools. Persists configs, transactions, positions, memory, logs to filesystem.

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

### Constants module

Single source for chain config (Unichain + 0G mainnet/testnet), token addresses, Uniswap fee tiers, looper tick interval. Never inline addresses, chainIds, RPC URLs, or magic numbers like polling intervals.

**Pool addresses + state are NOT constants.** `UniswapService` derives the v4 PoolKey + on-chain pool address + state from `(tokenA, tokenB, feeTier)` at runtime. `constants/` only holds `FEE_TIERS` (Uniswap-defined: 500 / 3_000 / 10_000 bps). Discovery helpers (`buildPoolKey`, `getPoolAddress`, `getPoolState`) live in the `uniswap/` module.

### No comments

Default: write none. Only when WHY is non-obvious (constraint, invariant, workaround).

## Architectural Decisions

### Modular DDD

Split by domain. Each module has one purpose, well-defined interface, testable in isolation.

```
src/
  agent-looper/         tick scheduler, gate logic
  agent-runner/         single-tick execution (callable, worker-ready)
  agent-activity-log/   per-agent JSON log of ticks, tool calls, LLM I/O, errors
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
  database/
    interface/          Database interface
    file-database/      FileDatabase implementation
    repositories/       AgentRepo, TransactionRepo, PositionRepo, AgentMemoryRepo
  constants/            chain config, token addresses, pool keys
  config/               env loader + zod validation
  index.ts              bootstrap → Looper.start()
```

### Single process, worker-ready

v1 = one Node process, sequential agent execution. `AgentRunner.run()` is a callable taking config + deps so it can move to a worker later with no refactor.

### Looper gate logic

Skip backlog. If N intervals missed (downtime), execute **once**, not N times. Update `lastTickAt = now` after run.

### Database = storage-agnostic facade, FileDatabase now

`Database` is a composition of repositories (`AgentRepository`, `TransactionRepository`, `PositionRepository`, `AgentMemoryRepository`) — no file paths or storage primitives leak through the interface. Domain types (`AgentConfig`, etc.) carry no `*FilePath` fields. v1 backend = `FileDatabase` resolving paths internally from `DB_DIR + entity id`. Swap to SQLite/Postgres later = mechanical.

We use files for v1 because they're easy to inspect by eye, not because the abstraction is file-shaped.

FileDatabase layout (implementation detail, gitignored under `./db/`):

- `database.json` — agent configs, transactions, positions
- `memory/<agentId>.json` — per-agent memory
- `activity-log/<agentId>.json` — per-agent event stream (owned by `agent-activity-log/`, separate module)
- `zerog-bootstrap.json` — 0G runtime state (provider address, sub-account secret, serviceUrl, model). Kept in db (not env / not constants) because creating it costs 0G tokens — losing the file = paying again.

Separation: `database/` = structured queryable state. `agent-activity-log/` = append-only event stream (own module, own storage abstraction `ActivityLogStore`).

### Wallet abstraction

Single `Wallet` interface. Two impls:

- `RealWallet` — viem signer from `WALLET_PRIVATE_KEY`
- `DryRunWallet` — same interface, ledger from dry-run Transactions (identified by sentinel hash)
- `WalletFactory.forAgent(config)` picks based on `agent.dryRun`

### Dry-run is a wiring concern

Agent **never knows** it's dry-run. Same tool surface, same return shapes. Same `Transaction` row shape (no `simulated` flag).

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

### Testing — providers/integrations only, live, `*.live.test.ts`

**Tests live only for modules that talk to an external system** (provider HTTP, blockchain RPC, 0G chain). Pure-logic modules (env loader, constants, looper, factories) get no dedicated tests — they're exercised end-to-end by `npm start` and downstream integration tests.

- **File suffix:** `*.live.test.ts`.
- **No mocked HTTP, no mocked external services.** Hit the real thing using UNI/USDC on Unichain.
- Tests skip themselves when the relevant API key / RPC is missing from `.env`.
- **Test style:** assert "we got something sensible", then `console.log` the payload so a human can eyeball it. Smoke checks + living usage examples. Avoid brittle assertions on exact response shapes.
- Only acceptable fake: **time** (vitest fake timers), and only when the module has no external dependency.

Two tiers:
- **Default (`npm test`)** — all live, all read-only. Runs in CI when keys present.
- **Interactive (`npm run test:interactive`)** — opt-in, for **any test that sends funds** (real pool swaps, real 0G top-ups). Requires `INTERACTIVE_TESTS=1` + per-call confirmation. Never in CI.

### Transactions + positions always recorded

Real or dry-run. Token in/out, gas (estimated for dry-run), status, block. Never lose money tracking.

## Slice Order (impl)

1. **Bootstrap** — project setup (package.json, tsconfig, vitest), `.gitignore`, `config/` env loader, `constants/`, all `providers/` with live UNI/USDC tests, empty `agent-looper/` that ticks but loads no agents
2. **Database + activity log** — `database/` (interface + FileDatabase + repositories) + `agent-activity-log/`
3. **Wallet** — real + dry-run + factory with tests
4. **Looper + AgentRunner skeleton** (mocked LLM, wires DB + wallet + log)
5. **AI integration** — 0G bootstrap, chat-model, real LLM in runner
6. **AI tools surface** — Langchain wrappers around providers + wallet
7. **Uniswap module + swap tools + risk enforcement**
8. **Seed agent** — UNI MA trader, end-to-end dry-run

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
```

Service URL, secret, model — discovered at bootstrap, persisted to `./db/zerog-bootstrap.json`. Looper tick interval lives in `constants/`, not env.
