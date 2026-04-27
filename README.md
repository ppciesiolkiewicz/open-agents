# open-agents-agent-loop

A TypeScript loop that fires AI agents on a schedule. Each agent runs an LLM-driven prompt with onchain (Uniswap v4 on Unichain) and offchain (price feeds, search, scrape, memory) tools, and persists every config, transaction, position, memory snapshot, and tick to disk.

The reference agent is a **UNI/USDC moving-average trader**: every minute it fetches the current price, maintains a rolling history, computes a 3/7-tick MA crossover, and (in dry-run) buys 25% of its USDC on golden cross or sells 100% of its UNI on death cross. Real LLM, real Uniswap v4 quotes, simulated wallet.

## Quick start

```bash
# 1. install
npm install

# 2. configure .env (see Configuration section below)
cp .env.example .env  # then edit
#   WALLET_PRIVATE_KEY=0x...   (32-byte hex; this wallet funds 0G inference + Unichain gas)
#   ALCHEMY_API_KEY=...        (Unichain RPC)
#   ZEROG_NETWORK=mainnet      (or testnet)
#   COINGECKO_API_KEY=...
#   COINMARKETCAP_API_KEY=...
#   SERPER_API_KEY=...
#   FIRECRAWL_API_KEY=...

# 3. fund a 0G inference provider (one-time; costs ~3 OG)
npm run zerog-bootstrap          # lists available providers
# pick one, set ZEROG_PROVIDER_ADDRESS in .env, re-run:
npm run zerog-bootstrap          # this run actually funds + persists

# 4. quick LLM sanity check (~tiny OG fee)
npm run llm:probe

# 5. install the seed agent + run the loop
npm run seed-agent
npm start
# watch:
#   db/activity-log/uni-ma-trader-001.json   ← every tick, every tool call
#   db/memory/uni-ma-trader-001.json         ← agent's evolving state
#   db/database.json                          ← simulated transactions + positions
```

## What it does

```
┌──────────────────────────────────────────────────────────────────────────┐
│ npm start                                                                 │
│                                                                           │
│  Looper ──┐                                                               │
│  (10s)    │  per outer tick:                                              │
│           ▼                                                               │
│      AgentOrchestrator   load enabled agents, filter due (skip backlog),  │
│           │              dispatch sequentially                            │
│           ▼                                                               │
│      AgentRunner         build prompt + tool list, call LLM, dispatch     │
│           │              tools per assistant message, accumulate history, │
│           │              cap at 10 tool-call rounds, log every event      │
│           ▼                                                               │
│      LLMClient ──► 0G inference proxy (OpenAI-compatible)                 │
│           │        per-call settlement headers via @0glabs broker SDK     │
│           ▼                                                               │
│      ToolRegistry: 12 tools                                               │
│           ├─ providers: fetchTokenPriceUSD, fetchTokenInfoBySymbol,       │
│           │             searchWeb, scrapeUrlMarkdown                      │
│           ├─ wallet:    getNativeBalance, getTokenBalance                 │
│           ├─ memory:    readMemory, updateMemory, saveMemoryEntry,        │
│           │             searchMemoryEntries                               │
│           └─ uniswap:   getUniswapQuoteExactIn, executeUniswapSwapExactIn │
│                                                                           │
│      WalletFactory  →  RealWallet (viem) | DryRunWallet (synthetic)       │
│      AgentActivityLog (NDJSON, append-only)                               │
│      Database (FileDatabase; agentId is the FK)                           │
└──────────────────────────────────────────────────────────────────────────┘
```

The agent never knows whether it's in dry-run mode. Same tool surface, same return shapes. The wallet impl decides at execution time whether to send a real transaction or mint a synthetic receipt with a sentinel hash.

## Configuration

`.env`:

```
# Chain (Unichain)
ALCHEMY_API_KEY=
UNICHAIN_RPC_URL=             # optional override; defaults to Alchemy URL

# Wallet (used for Unichain trading AND 0G broker funding)
WALLET_PRIVATE_KEY=

# 0G chain (AI inference)
ZEROG_NETWORK=testnet         # mainnet | testnet
ZEROG_PROVIDER_ADDRESS=       # optional; bootstrap auto-picks otherwise

# Data providers
COINGECKO_API_KEY=
COINMARKETCAP_API_KEY=
SERPER_API_KEY=
FIRECRAWL_API_KEY=

# Runtime
DB_DIR=./db
LOG_LEVEL=info
```

The 0G `serviceUrl` / `secret-equivalent` / `model` are discovered at bootstrap time and persisted to `./db/zerog-bootstrap.json` — losing that file means re-funding (~3 OG), so it's preserved by `npm run reset-db` by default.

## Scripts

| Command | Cost | What it does |
|---|---|---|
| `npm install` | — | install deps |
| `npm test` | — | run all live + unit tests (read-only; safe to run frequently) |
| `npm run typecheck` | — | typecheck source AND test files (both tsconfigs) |
| `npm run build` | — | compile TypeScript to `dist/` |
| `npm start` | — | run the agent loop (uses configured LLM, falls back to StubLLMClient if no `zerog-bootstrap.json`) |
| `npm run dev` | — | same as `npm start` but with `tsx watch` for hot reload |
| `npm run zerog-bootstrap` | ~3 OG (one-time) + 1 OG (top-up) | list 0G providers + fund a sub-account |
| `npm run llm:probe` | tiny OG fee | send one trivial inference to your funded provider |
| `npm run swap:buy-uni` | 0.5 USDC + ~$0.01 gas | swap 0.5 USDC → UNI on Unichain (opens position) |
| `npm run swap:sell-uni` | 0.1 UNI + ~$0.01 gas | swap 0.1 UNI → USDC on Unichain (closes most-recent UNI position) |
| `npm run seed-agent` | — | install canonical UNI MA trader (default `dryRun: true`) |
| `npm run seed-agent -- --real` | — | install seed in REAL onchain mode (every swap broadcasts; needs wallet UNI/USDC + gas) |
| `npm run reset-db` | — | wipe `db/` (preserves `zerog-bootstrap.json`) |
| `npm run reset-db -- --all` | — | wipe `db/` entirely (you'll need to re-fund 0G) |

Every script that spends OG, gas, or anything paid prompts `[y/N]` before doing anything destructive. Decline → no-op exit. Confirm → run.

## Tools available to every agent (12)

| Tool | Returns | Use |
|---|---|---|
| `fetchTokenPriceUSD(symbol)` | `{symbol, priceUSD}` | live USD price via Coingecko |
| `fetchTokenInfoBySymbol(symbol)` | `{id, name, symbol, slug}` | project metadata via CoinMarketCap |
| `searchWeb(query)` | top 5 organic results | Google via Serper |
| `scrapeUrlMarkdown(url)` | markdown (≤4000 chars) | Firecrawl |
| `getNativeBalance()` | `{raw, unit}` | wallet ETH balance on Unichain |
| `getTokenBalance(tokenAddress)` | `{tokenAddress, raw}` | wallet ERC-20 balance |
| `readMemory({recentEntries?})` | `{state, notes, recentEntries}` | load own persistent memory |
| `updateMemory({state?, appendNote?})` | `{ok, stateKeys, notesChars}` | replace state + append timestamped note |
| `saveMemoryEntry({type, content, parentEntryIds?})` | `{ok, entryId, totalEntries}` | append a `snapshot` / `observation` / `gist` / `note` to history |
| `searchMemoryEntries({query, type?, limit?})` | `{matches}` | substring search past entries |
| `getUniswapQuoteExactIn({tokenIn, tokenOut, amountIn, feeTier?})` | `{amountOut, feeTier, ...}` | Uniswap v4 quote via V4Quoter |
| `executeUniswapSwapExactIn({tokenIn, tokenOut, amountIn, slippageBps?, feeTier?})` | `{transactionId, hash, status, openedPositionId?, closedPositionId?, realizedPnlUSD?}` | execute the swap via UniversalRouter (auto-approves Permit2) — risk-gated by `agent.riskLimits.maxTradeUSD` and `maxSlippageBps` |

## Memory model

Each agent has a single `AgentMemory` document:

```ts
{
  agentId: string;
  state: Record<string, unknown>;     // structured, current
  notes: string;                       // free-form, current
  updatedAt: number;
  entries: MemoryEntry[];              // append-only history
}

MemoryEntry {
  id: string;
  tickId: string;
  type: 'snapshot' | 'observation' | 'gist' | 'note';
  content: string;
  parentEntryIds?: string[];           // for gists summarizing prior entries
  embedding?: number[];                // reserved; future similarity search
  createdAt: number;
}
```

Stored at `db/memory/<agentId>.json`. The LLM uses `readMemory` to load, `updateMemory` to overwrite state + append timestamped note, `saveMemoryEntry` to append history, `searchMemoryEntries` to recall past observations.

## Risk controls

Every swap goes through a tool-wrapper risk gate before reaching `UniswapService`:

```ts
agent.riskLimits = {
  maxTradeUSD: 100,        // reject swaps where (amountIn × Coingecko USD price) > 100
  maxSlippageBps: 200,     // cap slippage at 2% (LLM can request lower per call)
}
```

Risk-gate failures throw → AgentRunner catches → tool message back to LLM as `error: ...`. The LLM can recover by adjusting and trying again.

## Dry-run

`agent.dryRun: true` swaps tokens through `WalletFactory` → `DryRunWallet`. The wallet:

- Returns synthetic `TransactionReceipt` with a sentinel hash (`0x` + 60 zeros + 4 hex)
- Records the swap as a normal `Transaction` in `database.json` (so `Position` tracking + P&L work end-to-end)
- Computes balances by replaying all the agent's transactions against `dryRunSeedBalances`

The agent's prompt and tool surface are identical regardless of dry-run state — wiring concern only. Operators flip `dryRun` in `db/database.json` (or the seed config) to switch.

## Stack

- **TypeScript** (Node 20+, strict mode, ES modules)
- **0G chain** — AI inference (OpenAI-compatible proxy) via `@0glabs/0g-serving-broker`
- **Uniswap v4** on Unichain — swap execution + quoting (PoolManager, UniversalRouter, V4Quoter, StateView, Permit2 — addresses in [`src/constants/uniswap.ts`](src/constants/uniswap.ts))
- **viem 2.x** — EVM client (Unichain reads, Permit2 approvals, swap execution)
- **ethers 6.x** — required by the 0G broker SDK; lives alongside viem
- **OpenAI SDK 4.x** — used internally to talk to the 0G proxy (we own the tool-loop ourselves; no Langchain)
- **zod + zod-to-json-schema** — tool input validation + OpenAI function-schema conversion
- **vitest** — testing
- **tsx** — running TypeScript directly (no build step needed for `npm start` / scripts)

## Testing

`npm test` runs only read-only operations:

- Unit tests for pure logic (constants, pool-key math, V4 actions encoder, position tracker, env loader)
- Live tests against real provider APIs (Coingecko, CMC, Serper, Firecrawl) — skip when API keys missing
- Live RPC reads against Unichain (PoolStateReader, SwapQuoter, Permit2 allowance reads, RealWallet balance reads) — skip when `WALLET_PRIVATE_KEY` invalid
- FileDatabase / FileActivityLogStore round-trips against tmpdir
- DryRunWallet ledger replay
- AgentRunner / AgentOrchestrator with a `ScriptedLLMClient` covering the tool loop, error path, and round-cap
- ToolRegistry composition (asserts the 12-tool list)

**Anything that costs money — OG, ETH gas, real swaps — lives in `scripts/` with explicit `[y/N]` confirmation, NOT in `*.live.test.ts`.** This way `npm test` is safe to run on every commit, in CI, in a tight loop, never burning your funds.

## Project status

Built across 8 spec slices:

| Slice | Tag | What |
|---|---|---|
| 1 | `slice-1-bootstrap` | project scaffold, env loader, constants, all 4 read-only providers |
| 2 | `slice-2-database` | FileDatabase + 4 repositories, `agent-activity-log/` NDJSON |
| 3 | `slice-3-wallet` | viem RealWallet + DryRunWallet (sentinel-hash ledger) + WalletFactory |
| 4 | `slice-4-runner-orchestrator` | tick scheduler, AgentRunner skeleton with mock LLM |
| 5 | `slice-5-zerog-llm` | real 0G inference (broker SDK + OpenAI-compatible proxy + per-call settlement headers) |
| 6 | `slice-6-tools` | 12-tool surface, native OpenAI tool calling, expanded memory model |
| 7 | `slice-7-uniswap` | Uniswap v4 on Unichain, auto-approve Permit2, risk-gated swap tool |
| 8 | `slice-8-seed-agent` | canonical UNI MA trader seed + `npm run seed-agent` + `npm run reset-db` |

Each slice's spec lives at [docs/superpowers/specs/](docs/superpowers/specs/), each plan at [docs/superpowers/plans/](docs/superpowers/plans/), and the engineering principles at [CLAUDE.md](CLAUDE.md).

## Source layout

```
src/
  agent-looper/         tick scheduler + AgentOrchestrator (skip-backlog gate)
  agent-runner/         per-tick worker (LLMClient + tool loop + activity log)
  agent-activity-log/   per-agent NDJSON event stream
  ai/
    zerog-broker/       0G bootstrap (provider discovery, fund sub-account, persist)
    chat-model/         ZeroGLLMClient (broker headers + openai SDK)
  ai-tools/             12 LLM-callable tools + ToolRegistry + zod-to-openai
  uniswap/              v4 PoolKey, StateView, V4Quoter, V4 actions encoder, SwapExecutor, PositionTracker, UniswapService
  wallet/
    real/               viem signer
    dry-run/            ledger-backed mock (sentinel hash)
    factory/            picks impl per agent
  providers/            coingecko, coinmarketcap, serper, firecrawl
  database/             interface + FileDatabase + 4 repos (agent, transaction, position, agentMemory)
  constants/            chain config (Unichain + 0G), tokens, fee tiers, looper interval
  config/               zod-validated env loader
  test-lib/             confirmContinue() y/n stdin helper (test-only)
  index.ts              bootstrap → Looper.start()
scripts/                operator commands (anything that spends money)
docs/superpowers/       specs + plans
```

## License

(none specified yet)
