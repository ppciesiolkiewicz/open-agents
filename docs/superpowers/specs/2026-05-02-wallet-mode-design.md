# Wallet Mode — design

Date: 2026-05-02
Status: design approved, ready for plan

## Problem

Today, every agent runs against the env-key `RealWallet` for both:
- **agent tools** (Unichain trading via `WalletFactory.forAgent`)
- **0G inference payments** (broker built once at worker boot from `WALLET_PRIVATE_KEY`)

Privy server wallets are provisioned per-user but unused outside the wallet-provisioner module. We want each user to be able to act with their own Privy wallet, while keeping operator-funded mode available for development and as a safety valve.

## Goals

- Add `WALLET_MODE=pk|privy|privy_and_pk` env var (default `pk` = current behavior).
- Route agent tool calls through the user's primary Privy `UserWallet` in `privy` and `privy_and_pk` modes.
- Route 0G inference payments through the user's primary Privy wallet in `privy` mode; keep the env PK signer for `pk` and `privy_and_pk`.
- Mode is global to a worker process — restart required to switch modes (matches the existing `dryRun` convention).

## Non-goals

- Per-user 0G ledger funding automation. The 0G bootstrap CLI continues to fund only the env PK wallet; per-user Privy wallet 0G funding is handled by an existing UI flow outside this spec.
- Per-agent or per-user mode override. `WALLET_MODE` is process-global.
- Migrating `zerog-bootstrap.json` to a multi-tenant store. Singleton stays.
- Replacing dry-run wiring. `agent.dryRun` continues to short-circuit `forAgent` regardless of mode.

## Mode matrix

| Mode | Agent tools wallet | 0G broker signer |
|---|---|---|
| `pk` | env-pk `RealWallet` | env-pk `ethers.Wallet` |
| `privy` | per-user `PrivyServerWallet` | per-user `PrivySigner` (0G chain) |
| `privy_and_pk` | per-user `PrivyServerWallet` | env-pk `ethers.Wallet` |

`agent.dryRun = true` overrides the tools column to `DryRunWallet` in all three modes; the 0G broker signer column is unaffected (LLM inference costs real money even for dry-run agents).

## Architecture

### Env

`src/config/env.ts` adds:

```ts
WALLET_MODE: z.enum(['pk', 'privy', 'privy_and_pk']).default('pk'),
```

`.env.example` updated in the same commit (per CLAUDE.md sync rule).

Worker logs the active mode at boot.

### `WalletFactory` (refactored)

```ts
type WalletMode = 'pk' | 'privy' | 'privy_and_pk';

interface ZeroGSignerHandle {
  signer: ethers.Signer;
  address: string;  // sync access for cache keying
}

class WalletFactory {
  constructor(deps: {
    env: WalletFactoryEnv;
    walletMode: WalletMode;
    transactions: TransactionRepository;
    userWallets: UserWalletRepository;
    privy: PrivyClient | null;          // null when walletMode === 'pk'
    publicClient: PublicClient;          // Unichain
    zerogProvider: ethers.Provider;      // ethers JsonRpcProvider on 0G chain
    zerogChainId: number;                // ZEROG_NETWORKS[network].chainId
  });

  forAgent(agent: AgentConfig): Promise<Wallet>;
  forZerogPayments(agent: AgentConfig): Promise<ZeroGSignerHandle>;
}
```

`forAgent` becomes async because resolving a user's primary wallet hits the DB. Caching by `agentId` stays.

`forZerogPayments`:
- `pk` / `privy_and_pk`: return a singleton `{ signer: ethers.Wallet(env.WALLET_PRIVATE_KEY, zerogProvider), address }` — built once in the constructor.
- `privy`: look up the agent's user's primary `UserWallet` via `userWallets.findPrimaryByUser(agent.userId)`, build a `PrivySigner(privy, uw.privyWalletId, uw.walletAddress, zerogChainId, zerogProvider)`. Cache by `userId`.

Errors:
- Missing primary `UserWallet` in `privy` or `privy_and_pk` mode: throw `agent ${id} (user ${userId}) has no primary UserWallet — provision one via POST /users/me/wallets`.

### `LLMClientFactory` (new — `src/ai/chat-model/llm-client-factory.ts`)

```ts
class LLMClientFactory {
  constructor(
    walletFactory: WalletFactory,
    bootstrapState: ZeroGBootstrapState | null,
  );

  async forAgent(agent: AgentConfig): Promise<LLMClient>;
  modelName(): string;  // bootstrapState?.model ?? 'stub'
}
```

`forAgent`:
- If `bootstrapState` is null: return `StubLLMClient` (unchanged fallback for dev environments without 0G bootstrap).
- Else: call `walletFactory.forZerogPayments(agent)` for the `{signer, address}` handle, build `ZeroGLLMClient` once per address, cache, return.

### `buildZeroGBroker` + `ZeroGLLMClient` (refactored)

Today both take `WALLET_PRIVATE_KEY` and construct an `ethers.Wallet` internally. Refactor signatures to accept a pre-built `ethers.Signer`:

```ts
buildZeroGBroker({ signer: ethers.Signer; ZEROG_NETWORK }): { broker, walletAddress };
new ZeroGLLMClient({ broker, providerAddress, serviceUrl, model });
```

The bootstrap CLI (`bootstrap-cli.ts`) constructs its own `ethers.Wallet` from the env PK and passes it in — bootstrap behavior unchanged.

### `AgentRunner`

Constructor takes `LLMClientFactory` instead of `LLMClient`. Inside `run(agent, ...)`, the first step is `const llm = await this.llmFactory.forAgent(agent);`. The rest of the tool loop uses `llm` exactly as today. `modelName()` calls migrate to `llm.modelName()` from the resolved instance.

### `worker.ts` wiring

- Remove the `buildLLM(env)` helper.
- Construct an `ethers.JsonRpcProvider` for 0G using `ZEROG_NETWORKS[bootstrapState.network ?? env.ZEROG_NETWORK]`.
- Build `WalletFactory` with the new deps. `privy` is the existing `PrivyClient` instance when mode is not `pk`, else `null`.
- Load `ZeroGBootstrapStore` once (existing logic). Pass state to `LLMClientFactory`.
- Pass `LLMClientFactory` to `AgentRunner`.
- Log `walletMode` at boot.

### `server.ts` wiring

`server.ts` does not run agents but does build a `WalletFactory` (for HTTP-driven actions and consistency). Apply the same constructor changes. Server uses `WalletFactory` only for `forAgent` paths today; `forZerogPayments` is worker-only but stays available.

## Constants

`ZEROG_NETWORKS` already exists in `constants/zerog-networks.ts` with `chainId` + `rpcUrl` for both networks. No new constants required.

## Bootstrap CLI

`npm run zerog-bootstrap` continues to use the env PK wallet only. Add a single line of CLI output: "0G ledger funding for Privy wallets is handled via the UI flow, not this script."

## Testing

Following the project's policy (live tests only for modules with external dependencies; nothing that spends money).

**Updated**
- `wallet-factory.live.test.ts` — extend to cover all three modes:
  - `forAgent`: returns `RealWallet` in `pk`, `PrivyServerWallet` in `privy`/`privy_and_pk` (when seeded user wallet exists).
  - `forZerogPayments`: returns env-pk signer in `pk`/`privy_and_pk`; returns `PrivySigner` in `privy`.
  - Per-user caching for `forZerogPayments` in `privy` mode (two agents from same user → same signer instance).
  - Missing primary `UserWallet` in `privy`/`privy_and_pk` → throws.
- `agent-orchestrator.live.test.ts` — update `WalletFactory` construction to new signature.

**New**
- `llm-client-factory.live.test.ts`:
  - Returns same `LLMClient` instance for two agents with the same signer address (cache hit).
  - Returns `StubLLMClient` when bootstrap state is missing.
  - Distinct instances for two agents from different users in `privy` mode (cache miss).

No tests cost real OG, ETH, or paid credits — broker construction and signer construction are read-only against RPC. Live tests require the existing env (`WALLET_PRIVATE_KEY`, `PRIVY_APP_ID`/`SECRET`, `TEST_DATABASE_URL`) and seeded `UserWallet` fixtures.

## Edge cases

- **Mode flip without restart**: caches retain stale wallets. Documented as restart-required, matches existing `dryRun` convention.
- **`dryRun=true` agent in any mode**: tools get `DryRunWallet` (mode ignored); 0G payments still routed through `forZerogPayments` (mode respected).
- **0G ledger empty for a user's Privy wallet** in `privy` mode: error surfaces from `ZeroGLLMClient.invokeWithTools` as today; activity log captures it; tick fails; orchestrator continues. No new handling.
- **Missing `PRIVY_APP_ID`/`PRIVY_APP_SECRET`**: `loadEnv` already requires both — no change. (If a future spec wants to allow `pk` mode without Privy creds, that's a separate change.)

## Migration

- Existing operators: no `.env` change required. `WALLET_MODE` defaults to `pk`.
- Operators opting into `privy` or `privy_and_pk`: every user with an agent must already have a primary `UserWallet`. Worker fails loud at first tick for any agent whose user lacks one.

## Out of scope (follow-ups)

- Per-user 0G bootstrap automation.
- Per-agent or per-user mode override.
- Replacing the singleton `zerog-bootstrap.json` with a multi-tenant store.
