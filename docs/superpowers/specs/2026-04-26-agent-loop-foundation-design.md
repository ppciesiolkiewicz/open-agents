# AI Agent Loop — Foundation Design

**Date:** 2026-04-26
**Status:** Approved (brainstorming phase)
**Scope:** Cross-slice design covering all 6 implementation slices. Each slice gets its own implementation plan via writing-plans.

## Goal

Build a TypeScript agent loop that fires AI agents on a schedule. Each agent runs a Langchain prompt with access to onchain (Uniswap v4 on Unichain) and offchain (price feeds, search, scrape) tools. Configuration, transactions, positions, memory, and logs are persisted to disk. Dry-run mode lets agents trade against simulated balances without onchain side effects.

## Stack

- **TypeScript** everywhere
- **0G chain** — AI inference (OpenAI-compatible at `<service_url>/v1/proxy`); SDK `@0glabs/0g-serving-broker` for one-time bootstrap (provider discovery, sub-account funding, secret retrieval). Mainnet: `https://evmrpc.0g.ai` (chainId 16661); Galileo testnet: `https://evmrpc-testnet.0g.ai` (chainId 16602). Same `WALLET_PRIVATE_KEY` is used to interact with the broker (must hold 0G on the chosen network).
- **Langchain** — tool framework, agent executor; `ChatOpenAI` pointed at 0G proxy
- **Uniswap v4** — swap execution + quoting on Unichain
- **viem** — EVM client
- **Alchemy** — primary RPC provider for Unichain (`https://unichain-mainnet.g.alchemy.com/v2/<KEY>`); plain `UNICHAIN_RPC_URL` env overrides when set
- **Data providers** — Coingecko, CoinMarketCap, Serper, Firecrawl

## Non-Goals (v1)

- Multi-process / worker-thread isolation (designed for, not implemented)
- Live UI for logs (logs are JSON, ready for later UI)
- DB other than filesystem
- Delegated wallets (interface ready, key-from-env only)
- Risk controls beyond `maxTradeUSD`

## Slice Decomposition

Each slice ships standalone. Earlier slices testable without later ones.

1. **Bootstrap** — project skeleton: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env` already provided. `config/` env loader (zod). `constants/` (Unichain + 0G networks + tokens + tick interval). `providers/{coingecko,coinmarketcap,serper,firecrawl}/` each as a class with a live read-only test using UNI/USDC. Empty `agent-looper/` that ticks every `LOOPER.tickIntervalMs` and logs — no agents loaded, no runner yet. End state: `npm test` passes, `npm start` runs the empty loop.
2. **Database + activity log** — `database/` (interface + FileDatabase + repositories) + `agent-activity-log/` module + storage layout under `./db/`.
3. **Wallet** — `wallet/{real,dry-run,factory}/` with live UNI/USDC balance read tests for `RealWallet` and ledger-math tests for `DryRunWallet`.
4. **Looper + AgentRunner skeleton** — gate logic (skip backlog), `AgentRunner` callable interface (worker-ready). Mocked LLM that echoes prompt. Wires Database + Wallet + activity log.
5. **AI integration** — `ai/zerog-broker/` bootstrap (uses `WALLET_PRIVATE_KEY` on chosen `ZEROG_NETWORK`), `ai/chat-model/` factory, replace mocked LLM in runner.
6. **AI tools surface** — `ai-tools/` Langchain wrappers around providers + wallet (read-only).
7. **Uniswap + swap tools** — `uniswap/` quote + executeSwapExactIn, risk-limit enforcement in `ai-tools` swap wrapper, transaction/position recording, dry-run swap path.
8. **Seed agent** — UNI MA trader config, end-to-end dry-run.

## Architecture

### Module layout

```
src/
  agent-looper/         Looper class — tick scheduler, gate logic
  agent-runner/         AgentRunner — single-tick execution, callable
  agent-activity-log/   AgentActivityLog — per-agent append-only JSON log
                        (tick boundaries, tool calls/results, LLM I/O,
                        memory updates, errors)
  ai/
    zerog-broker/       ZeroGBrokerService — bootstrap, fund, get secret
    chat-model/         buildChatModel() → Langchain ChatOpenAI for 0G proxy
  ai-tools/             ToolRegistry — composes other modules as Langchain tools
  uniswap/              UniswapService — getQuote, executeSwapExactIn
  wallet/
    real/               RealWallet (viem signer)
    dry-run/            DryRunWallet (ledger from dry-run Transactions, sentinel hash)
    factory/            WalletFactory.forAgent(config) → Wallet
  providers/
    coingecko/
    coinmarketcap/
    serper/
    firecrawl/
  database/
    interface/          Database interface
    file-database/      FileDatabase implements Database
    repositories/       AgentRepo, TransactionRepo, PositionRepo, AgentMemoryRepo
  constants/            Unichain + 0G chain config, TOKENS, FEE_TIERS, looper interval
  config/               env loader + validation (zod)
  index.ts              bootstrap → Looper.start()
```

Note: `agent-activity-log` is the per-agent JSON execution log (designed for later UI render), distinct from `database/` which holds configs, transactions, positions, and per-agent memory.

### Module style

All modules are **classes**. Static factory methods when stateless; instances when holding dependencies (e.g. `new UniswapService(walletFactory, db)`). No bare-function modules.

### Function naming

Verb + what + qualifier. `fetchTokenPriceFromCoingecko(symbol)`, `executeUniswapSwapExactIn(...)`, `loadAgentMemoryFromDisk(agentId)`. Avoid bare `get`, `do`, `swap`, `load`.

### Default chain

Unichain. Read from `constants/`, never inline `chainId`.

## Loop Mechanics

`Looper.start()` runs `setInterval` every `LOOPER.tickIntervalMs` (from `constants/`). Per outer tick:

1. Load enabled agents from DB.
2. For each agent: `due = (now - (lastTickAt ?? 0)) >= intervalMs`.
3. If due: enqueue single `AgentRunner.run(agent)` invocation. **Skip backlog** — even if 5 intervals were missed (downtime, network), run once.
4. After run completes (success or failure), persist `lastTickAt = now` and updated memory.
5. Runs are sequential within v1 (single process). `AgentRunner.run` is a pure callable that takes the agent config + dependencies, so it can move to a worker later without refactor.

## DB

`Database` is a storage-agnostic facade composed of repositories. v1 backend = `FileDatabase`; later backends (SQLite, Postgres) implement the same interfaces.

**FileDatabase storage layout** (implementation detail, not visible through the interface):

```
./db/                        # gitignored, path from DB_DIR env
  database.json              # AgentConfig[], Transaction[], Position[]
  memory/<agentId>.json      # AgentMemory per agent (owned by database/)
  activity-log/<agentId>.json  # AgentActivityLogEntry[] per agent
                               # (owned by agent-activity-log/)
  zerog-bootstrap.json         # 0G runtime state (provider, secret, serviceUrl, model)
                               # — saved AFTER paying to fund a sub-account so we
                               # don't burn 0G tokens on every restart. See "AI
                               # Integration (0G)" section for the constants vs
                               # db split.
```

Path resolution (e.g. `memory/<agentId>.json`) is internal to `FileDatabase` and `agent-activity-log/`. Domain types like `AgentConfig` carry no file paths.

### Schema

**Ownership model — relational by `agentId`:** `Database` is a single global instance, not instantiated per agent. We store everything in one JSON file (`database.json`) and relate entities the same way a relational DB would: every row carries `agentId` as a foreign key pointing to `AgentConfig.id`.

```
AgentConfig.id  ←─ Transaction.agentId
                ←─ Position.agentId
                ←─ AgentMemory.agentId
                ←─ AgentActivityLogEntry.agentId
```

Repository methods derive ownership from the entity itself — `transactions.insert(tx)` reads `tx.agentId`, no separate "which agent?" parameter. Listing uses `listByAgent(agentId)` as a filter.

**FileDatabase storage choice:** transactions + positions sit in flat arrays inside `database.json`; memory + activity-log are sharded into per-agent files (`memory/<agentId>.json`, `activity-log/<agentId>.json`) for human inspectability and append performance. Either way the relation is the same `agentId` FK — the interface hides the layout.

```ts
// Database = composition of repositories. No storage primitives leak through.
// Concrete impls (FileDatabase) resolve their own paths from DB_DIR + entity ids.

interface Database {
  agents: AgentRepository;
  transactions: TransactionRepository;
  positions: PositionRepository;
  agentMemory: AgentMemoryRepository;
}

interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  findById(id: string): Promise<AgentConfig | null>;
  upsert(agent: AgentConfig): Promise<void>;
  delete(id: string): Promise<void>;
}

interface TransactionRepository {
  insert(tx: Transaction): Promise<void>;
  findById(id: string): Promise<Transaction | null>;
  listByAgent(agentId: string, opts?: { limit?: number }): Promise<Transaction[]>;
  updateStatus(id: string, patch: Pick<Transaction, 'status' | 'blockNumber' | 'hash'>): Promise<void>;
}

interface PositionRepository {
  insert(pos: Position): Promise<void>;
  findOpen(agentId: string, tokenAddress: string): Promise<Position | null>;
  listByAgent(agentId: string): Promise<Position[]>;
  update(pos: Position): Promise<void>;
}

interface AgentMemoryRepository {
  get(agentId: string): Promise<AgentMemory | null>;
  upsert(memory: AgentMemory): Promise<void>;
}

// Activity log lives in `agent-activity-log/` module (separate from Database)
// but follows the same storage-agnostic shape:
interface ActivityLogStore {
  append(entry: AgentActivityLogEntry): Promise<void>;
  listByAgent(agentId: string, opts?: { limit?: number; sinceTickId?: string }): Promise<AgentActivityLogEntry[]>;
}

interface AgentConfig {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  prompt: string;
  walletAddress: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>; // tokenAddr → raw bigint string
  riskLimits: { maxTradeUSD: number; [k: string]: unknown }; // extensible
  lastTickAt: number | null;
  createdAt: number;
}

interface Transaction {
  id: string;
  agentId: string;
  hash: string;                   // see "Dry-run hash sentinel" below
  chainId: number;
  from: string;
  to: string;
  tokenIn?: TokenAmount;
  tokenOut?: TokenAmount;
  gasUsed: string;                // bigint as string; estimated for dry-run
  gasPriceWei: string;            // estimated for dry-run (current network gas price)
  gasCostWei: string;             // gasUsed * gasPriceWei
  status: 'pending' | 'success' | 'failed';
  blockNumber: number | null;     // null for dry-run
  timestamp: number;
}

// A Position is a tracked token holding opened by one swap and closed by another.
// Both ends reference the originating Transaction so we can trace P&L back to txs.
interface Position {
  id: string;
  agentId: string;
  amount: TokenAmount;            // token + amount held while position is open
  costBasisUSD: number;
  openedByTransactionId: string;
  closedByTransactionId?: string;
  openedAt: number;
  closedAt: number | null;
  realizedPnlUSD: number | null;
}

interface TokenAmount {
  tokenAddress: string;
  symbol: string;
  amountRaw: string;              // bigint as string
  decimals: number;
}

interface AgentMemory {
  agentId: string;
  notes: string;
  state: Record<string, unknown>;
  updatedAt: number;
}

interface AgentActivityLogEntry {
  agentId: string;
  tickId: string;
  timestamp: number;
  type:
    | 'tick_start' | 'tick_end'
    | 'tool_call' | 'tool_result'
    | 'llm_call' | 'llm_response'
    | 'memory_update' | 'error';
  payload: Record<string, unknown>;
}
```

bigints serialized as strings everywhere in JSON.

### Dry-run hash sentinel

Dry-run swaps still record a `Transaction` row — same shape, same fields. Instead of carrying a `simulated: boolean` flag we use a recognizable sentinel hash pattern: **`0x` + 60 zeros + 4 hex chars** (a counter or timestamp suffix to keep each one unique).

```
real:    0xa1f3...c9b2 (random 64 hex)
dry-run: 0x000000000000000000000000000000000000000000000000000000000000abcd
```

Detection is a regex (`/^0x0{60}[0-9a-f]{4}$/`); real Ethereum transaction hashes have ~16⁻⁶⁰ chance of matching, so the sentinel is safe.

For dry-run rows the other fields are populated as follows:
- `gasUsed`, `gasPriceWei`, `gasCostWei` — estimated values (real-time gas price from RPC × the swap's typical gas usage), so dry-run cost accounting matches real-world economics
- `blockNumber` — `null`
- `status` — `'success'` (dry-run never fails for blockchain reasons; risk-limit / quote failures throw before a Transaction is written)
- `tokenIn`/`tokenOut` — exactly the quote-derived amounts from `UniswapService.getQuote`

Wallets compute dry-run balances by replaying these Transaction rows against the seed:
- Filter `Transaction[]` where `agentId = X AND hash matches sentinel pattern`
- For each row: subtract `tokenIn.amountRaw` from that token's balance, add `tokenOut.amountRaw` to the other, subtract `gasCostWei` from `"native"`

## Wallet

Single interface, two implementations.

```ts
interface Wallet {
  getAddress(): string;
  getNativeBalance(): Promise<bigint>;
  getTokenBalance(tokenAddress: string): Promise<bigint>;
  signAndSendTransaction(req: TxRequest): Promise<TxReceipt>;
}
```

- `RealWallet` — viem signer from `WALLET_PRIVATE_KEY`. Reads on-chain balances.
- `DryRunWallet` — same interface. Computes balance as `seed + sum(deltas from sentinel-hash txs)` (see "Dry-run hash sentinel" above). Native (gas) balance is part of `dryRunSeedBalances` under the sentinel key `"native"`; estimated gas costs from dry-run swaps debit it like any other token. `signAndSendTransaction` writes a Transaction with a sentinel hash and returns a synthetic receipt with the same hash.
- `WalletFactory.forAgent(config)` returns the right impl based on `agent.dryRun`.

**Agent never knows it's in dry-run.** Same tool surface, same return shapes. Dry-run is a wiring concern.

## Uniswap

```ts
class UniswapService {
  constructor(private walletFactory: WalletFactory, private db: Database) {}

  // Pool discovery — derive pool info at runtime, not from constants.
  buildPoolKey(tokenA: TokenInfo, tokenB: TokenInfo, feeTier: number): PoolKey;
  async getPoolAddress(key: PoolKey): Promise<`0x${string}`>;
  async getPoolState(key: PoolKey): Promise<{ sqrtPriceX96: bigint; liquidity: bigint; tick: number }>;

  // Quoting + execution
  async getQuoteExactIn(args: QuoteArgs): Promise<Quote>;
  async executeSwapExactIn(args: SwapArgs, agent: AgentConfig): Promise<Transaction>;
}
```

**Pool info is derived at runtime, not stored as a constant.** Given two tokens + a fee tier, `buildPoolKey` produces the canonical Uniswap v4 PoolKey (sorted token order, hooks address, etc.) and `getPoolAddress` / `getPoolState` query the chain. The `constants/` module only holds **fee tier numbers** (`FEE_TIERS = { LOW: 500, MEDIUM: 3_000, HIGH: 10_000 }` — Uniswap-defined) and **token metadata** (already in `TOKENS`). Pool addresses and live state never live in constants.

`executeSwapExactIn`:
1. Call `getQuoteExactIn` to derive expected `amountOut` and USD notional.
2. Resolve wallet via `walletFactory.forAgent(agent)`.
3. Build calldata, call `wallet.signAndSendTransaction`. (DryRunWallet writes a sentinel-hash tx + synthetic receipt instead.)
4. Persist `Transaction`. Insert/update `Position` records with `openedByTransactionId` / `closedByTransactionId` pointing back at the tx.

**Risk enforcement lives in the tool wrapper (`ai-tools/`), not in `UniswapService`** — single enforcement point keeps `UniswapService` reusable for non-agent callers (e.g. CLI utilities, tests).

The same code path serves real and dry-run — divergence happens inside the wallet impl.

## AI Integration (0G)

### Constants vs db split

There are two kinds of 0G config and they live in different places:

| Kind | Where | Why |
|---|---|---|
| **Static network config** — chain IDs, RPC URLs for mainnet/testnet | `constants/zerog-networks.ts` | Doesn't change per environment; safe in source. |
| **Bootstrap runtime state** — provider address, sub-account secret, serviceUrl, model | `./db/zerog-bootstrap.json` | Only valid AFTER we've funded a sub-account on-chain; must persist so we don't pay 0G tokens to re-fund every restart. |

The bootstrap file exists specifically because **funding a 0G sub-account costs 0G tokens** — losing the file means burning tokens to fund a new one. Treat it like a wallet artifact, not a config.

### Bootstrap flow

`ZeroGBrokerService.bootstrap(env)`:
- Connects to 0G chain via `ZEROG_NETWORK` (mainnet|testnet, RPC + chainId from `constants/`) using `WALLET_PRIVATE_KEY` — that wallet must hold 0G on the chosen network.
- If `./db/zerog-bootstrap.json` exists and matches the requested network → load + return its `{ providerAddress, serviceUrl, model, secret }`. Skip everything below.
- Otherwise: `broker.inference.listService()`, auto-pick first available provider (or one matching optional `ZEROG_PROVIDER_ADDRESS` override), deposit + transfer 0G to provider sub-account, fetch `app-sk-<SECRET>` and the provider's `serviceUrl` + `model`.
- Persist `{ network, providerAddress, serviceUrl, model, secret }` to `./db/zerog-bootstrap.json` (gitignored). Re-bootstrap manually (delete the file) when funds run low or provider changes.

`buildChatModel(cfg)`:
```ts
return new ChatOpenAI({
  apiKey: cfg.secret,
  configuration: { baseURL: `${cfg.serviceUrl}/v1/proxy` },
  modelName: cfg.model,
});
```

`AgentRunner` constructs the chat model + Langchain agent executor with the full `ToolRegistry`, runs the prompt, persists memory and logs.

## Tools

v1: **all tools available to every agent**. No per-agent allowlist (will add later via `enabledTools: string[]`).

Tool wrappers live in `ai-tools/`. Each wraps a service method as a Langchain `DynamicStructuredTool` with a zod schema.

Initial tool surface:
- `fetchTokenPriceFromCoingecko(symbol)` → USD
- `fetchTokenInfoFromCoinMarketCap(symbol)` → metadata
- `searchWebViaSerper(query)` → results
- `scrapeUrlViaFirecrawl(url)` → markdown
- `getWalletNativeBalance()` → bigint
- `getWalletTokenBalance(tokenAddress)` → bigint
- `getUniswapQuoteExactIn(tokenIn, tokenOut, amountIn)` → Quote
- `executeUniswapSwapExactIn(tokenIn, tokenOut, amountIn, slippageBps)` → Transaction

### Example: tool definition + agent usage

`ai-tools/swap-tool.ts` (illustrative — actual code lands in slice 7):

```ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export class SwapToolBuilder {
  constructor(
    private readonly uniswap: UniswapService,
    private readonly coingecko: CoingeckoService,
  ) {}

  buildExecuteSwapExactInTool(agent: AgentConfig): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'executeUniswapSwapExactIn',
      description:
        'Swap exactly `amountIn` of `tokenIn` for at least the slippage-adjusted ' +
        'amount of `tokenOut` on Uniswap v4 (Unichain). Returns the resulting ' +
        'Transaction record. Enforces the agent\'s maxTradeUSD risk limit.',
      schema: z.object({
        tokenIn: z.string().describe('Token symbol (e.g. "USDC", "UNI")'),
        tokenOut: z.string().describe('Token symbol (e.g. "USDC", "UNI")'),
        amountIn: z.string().describe('Raw bigint amount of tokenIn (in tokenIn decimals)'),
        slippageBps: z.number().int().min(1).max(10_000)
          .describe('Max acceptable slippage in basis points (e.g. 50 = 0.5%)'),
      }),
      func: async (input) => {
        // 1. Resolve symbols to TokenInfo via constants/TOKENS
        const tokenIn = TOKENS[input.tokenIn as TokenSymbol];
        const tokenOut = TOKENS[input.tokenOut as TokenSymbol];
        if (!tokenIn || !tokenOut) throw new Error(`Unknown token: ${input.tokenIn}/${input.tokenOut}`);

        // 2. Quote first, derive USD notional for risk check
        const quote = await this.uniswap.getQuoteExactIn({ tokenIn, tokenOut, amountIn: BigInt(input.amountIn) });
        const tokenInPriceUSD = await this.coingecko.fetchTokenPriceUSD(coingeckoIdFor(tokenIn));
        const notionalUSD = Number(input.amountIn) / 10 ** tokenIn.decimals * tokenInPriceUSD;

        // 3. Risk enforcement (single point — see Uniswap section)
        if (notionalUSD > agent.riskLimits.maxTradeUSD) {
          throw new Error(`Trade ${notionalUSD.toFixed(2)} USD exceeds maxTradeUSD ${agent.riskLimits.maxTradeUSD}`);
        }

        // 4. Execute (real or dry-run, decided by WalletFactory inside UniswapService)
        const tx = await this.uniswap.executeSwapExactIn(
          { tokenIn, tokenOut, amountIn: BigInt(input.amountIn), slippageBps: input.slippageBps, quote },
          agent,
        );
        return JSON.stringify(tx);
      },
    });
  }
}
```

`AgentRunner.run(agent)` (illustrative — slice 4):

```ts
const tools: DynamicStructuredTool[] = [
  toolBuilders.coingeckoPrice.build(),
  toolBuilders.cmcInfo.build(),
  toolBuilders.serperSearch.build(),
  toolBuilders.firecrawlScrape.build(),
  toolBuilders.walletBalance.buildForAgent(agent),
  toolBuilders.swap.buildExecuteSwapExactInTool(agent),
  // ...
];

const executor = AgentExecutor.fromAgentAndTools({
  agent: createOpenAIFunctionsAgent({ llm: chatModel, tools, prompt }),
  tools,
  callbacks: [activityLogger.callbackHandler(agent.id, tickId)],
});

await executor.invoke({ input: agent.prompt + '\n\nMemory:\n' + JSON.stringify(memory.state) });
```

Note: tools that need agent context (`agent.riskLimits`, `agent.dryRun` via WalletFactory) are constructed **per-tick per-agent** (`buildForAgent(agent)`). Stateless tools (price/search) are built once and reused.

## Constants

```ts
export const UNICHAIN = {
  chainId: 130,
  rpcUrl: env.UNICHAIN_RPC_URL
    ?? `https://unichain-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`,
  nativeSymbol: 'ETH',
};

export const ZEROG_NETWORKS = {
  mainnet: { chainId: 16661, rpcUrl: 'https://evmrpc.0g.ai' },
  testnet: { chainId: 16602, rpcUrl: 'https://evmrpc-testnet.0g.ai' }, // Galileo
} as const;

export const LOOPER = {
  tickIntervalMs: 10_000,   // outer poll cadence (per-agent intervals are in AgentConfig)
} as const;

export const TOKENS = {
  USDC: { address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', decimals: 6, symbol: 'USDC' },
  UNI:  { address: '0x8f187aA05619a017077f5308904739877ce9eA21', decimals: 18, symbol: 'UNI' },
} as const;

// Uniswap v4 fee tiers — Uniswap-defined constants, safe to encode here.
// Pool addresses + state are NOT constants; UniswapService derives them at
// runtime from (tokenA, tokenB, feeTier).
export const FEE_TIERS = {
  LOW: 500,        // 0.05%
  MEDIUM: 3_000,   // 0.3%
  HIGH: 10_000,    // 1%
} as const;
```

## Env

```
# Chain (Unichain)
ALCHEMY_API_KEY=
UNICHAIN_RPC_URL=             # optional override; defaults to Alchemy URL

# Wallet (used for both Unichain trading and 0G broker funding)
WALLET_PRIVATE_KEY=

# 0G chain (AI inference)
ZEROG_NETWORK=testnet         # mainnet | testnet
ZEROG_PROVIDER_ADDRESS=       # optional override; bootstrap auto-picks otherwise

# Data providers
COINGECKO_API_KEY=
COINMARKETCAP_API_KEY=
SERPER_API_KEY=
FIRECRAWL_API_KEY=

# Runtime
DB_DIR=./db
LOG_LEVEL=info
```

Validated via `zod` in `config/`.

## Seed Agent

`db/database.json` bootstrap entry:

```json
{
  "agents": [
    {
      "id": "uni-ma-trader-001",
      "name": "UNI Moving Average Trader",
      "enabled": true,
      "intervalMs": 180000,
      "prompt": "You trade UNI/USDC on Unichain via Uniswap v4. Every tick: fetch UNI price, compute short MA (last 5 ticks from memory.state.priceHistory) and long MA (last 20 ticks). If short crosses above long and you hold USDC, swap 10% of USDC into UNI. If short crosses below long and you hold UNI, swap 100% of UNI into USDC. Append the latest price to memory.state.priceHistory (keep last 50). Always check wallet balance before trading. Log your reasoning.",
      "walletAddress": "",
      "dryRun": true,
      "dryRunSeedBalances": {
        "native": "100000000000000000",
        "0x078D782b760474a361dDA0AF3839290b0EF57AD6": "1000000000"
      },
      "riskLimits": { "maxTradeUSD": 100 },
      "lastTickAt": null,
      "createdAt": 0
    }
  ],
  "transactions": [],
  "positions": []
}
```

(Seed: 0.1 ETH for gas + 1000 USDC for trading. USDC raw amount with 6 decimals; ETH with 18.)

`walletAddress` is filled at agent-create time by deriving from the configured wallet; left empty in the bootstrap seed.

## Testing Strategy

### Rule: tests are for providers/integrations only

Only modules that talk to an external system (provider HTTP API, blockchain RPC, 0G chain, filesystem when relevant) ship a test. Pure-logic modules (env loader, constants, looper, factories) are exercised end-to-end by `npm start` and the integration tests downstream — no dedicated tests.

**Test file suffix:** `*.live.test.ts`. **No mocked HTTP, no mocked external services.** Tests hit the real thing using UNI/USDC on Unichain, skip themselves when their API key / RPC is missing from `.env`, and `console.log` the response so a human can eyeball it. Tests are smoke checks AND living usage examples — assert "the thing returned something sensible", then log the payload. Avoid brittle assertions on exact response shapes.

Two tiers:

- **Default (`npm test`)** — runs in CI. All live, all read-only. Includes:
  - Live provider calls (Coingecko UNI price, CMC UNI info, Serper UNI search, Firecrawl uniswap.org scrape)
  - Live `RealWallet` balance reads against Unichain
  - Live Uniswap `getQuote` for UNI/USDC (no swap)
  - `FileDatabase` round-trip (real filesystem)
  - 0G chat-model integration with a trivial prompt (skipped without `db/zerog-bootstrap.json`)
- **Interactive (`npm run test:interactive`)** — opt-in only, **for any test that sends funds (real pool swaps, real 0G top-ups beyond initial fund)**. Requires `INTERACTIVE_TESTS=1` + explicit confirmation prompt before each fund-sending call. Never in CI.

The only acceptable fake anywhere in the test tree is **time** (vitest fake timers) — and only when the module has no external dependency to begin with.

### Per-provider live testcase requirement

Every provider/integration module ships with a runnable `*.live.test.ts` using the UNI/USDC pair on Unichain:
- `coingecko/` — fetches UNI + USDC prices, logs them
- `coinmarketcap/` — fetches UNI + USDC info, logs them
- `serper/` — searches "UNI token Uniswap", logs top results
- `firecrawl/` — scrapes uniswap.org, logs markdown preview
- `wallet/real/` — reads UNI + USDC balances on Unichain, logs them
- `uniswap/` — `getQuote` for UNI↔USDC (default tier); real swap (interactive tier)

### Per-slice coverage

- **Bootstrap slice:** live provider tests above; no tests for env / constants / Looper.
- **Database + activity log slice:** `FileDatabase` round-trip on real filesystem.
- **Wallet slice:** live `RealWallet` balance reads on Unichain; `DryRunWallet` exercised by Uniswap dry-run tests.
- **Looper + Runner slice:** live runner tick with the production stub LLM (not a test mock).
- **AI slice:** live 0G integration with a trivial prompt.
- **Tools slice:** live tool calls round-tripping through Langchain.
- **Uniswap slice:** live `getQuote` (default); real swap (interactive only).
- **Seed agent slice:** live end-to-end dry-run tick produces logs + memory update.

## Open Questions Deferred to Later Slices

- Risk control expansion (`maxSlippageBps`, daily caps, cooldowns) — added when slice 5 lands and trading patterns are observed.
- Per-agent tool allowlist — added when scope grows beyond manual experimentation.
- Worker-thread isolation — added if/when single-process becomes a bottleneck.
- DB swap from filesystem — `Database` interface already permits it.
