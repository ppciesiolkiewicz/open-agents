# Wallet Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `WALLET_MODE=pk|privy|privy_and_pk` env var that routes both agent-tool wallets and 0G inference signers per mode.

**Architecture:** `WalletFactory` gains a `walletMode` dep and a new async `forZerogPayments` method returning `{ signer, address }`. A new `LLMClientFactory` wraps `WalletFactory.forZerogPayments` + bootstrap state, building/caching one `ZeroGLLMClient` per signer address. `AgentRunner` takes `LLMClientFactory` instead of a singleton `LLMClient` and resolves the LLM per tick. `buildZeroGBroker` is refactored to accept a pre-built `ethers.Signer` so both env-pk wallets and `PrivySigner` instances flow through the same code path.

**Tech Stack:** TypeScript, vitest, viem (Unichain), ethers v6 (0G), `@privy-io/server-auth`, Postgres via Prisma, zod.

**Spec:** [docs/superpowers/specs/2026-05-02-wallet-mode-design.md](../specs/2026-05-02-wallet-mode-design.md)

---

## File Map

**Modify:**
- `src/config/env.ts` — add `WALLET_MODE` to zod schema
- `.env.example` — add `WALLET_MODE` block (sync per CLAUDE.md rule)
- `src/ai/zerog-broker/zerog-broker-factory.ts` — refactor `buildZeroGBroker` to take `ethers.Signer`
- `src/ai/zerog-broker/bootstrap-cli.ts` — construct `ethers.Wallet` from env pk and pass into `buildZeroGBroker`; add UI-flow note
- `src/wallet/factory/wallet-factory.ts` — new ctor deps, mode dispatch, async `forAgent`, new `forZerogPayments`
- `src/wallet/factory/wallet-factory.live.test.ts` — extend coverage to all three modes
- `src/agent-runner/agent-runner.ts` — take `LLMClientFactory` instead of `LLMClient`; await `walletFactory.forAgent`
- `src/agent-runner/agent-runner.live.test.ts` — adapt ctor calls to new signature
- `src/agent-worker/agent-orchestrator.live.test.ts` — adapt ctor calls
- `src/worker.ts` — drop `buildLLM`, build `LLMClientFactory`, wire new `WalletFactory` deps

**Create:**
- `src/ai/chat-model/llm-client-factory.ts`
- `src/ai/chat-model/llm-client-factory.live.test.ts`

**Untouched (verify):**
- `src/server.ts` — does not use `WalletFactory`; no changes
- `src/wallet/privy/privy-signer.ts` — already takes `ethers.Provider` + `chainId`; no changes
- `src/ai/chat-model/zerog-llm-client.ts` — already takes a pre-built broker; no changes

---

## Task 1: Add `WALLET_MODE` to env

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add `WALLET_MODE` to the zod schema**

In `src/config/env.ts`, inside the `envSchema = z.object({ ... })` block, after the `PRIVY_APP_SECRET` line:

```ts
  WALLET_MODE: z.enum(['pk', 'privy', 'privy_and_pk']).default('pk'),
```

- [ ] **Step 2: Add `WALLET_MODE` to `.env.example`**

Append a block to `.env.example` (after the existing Privy block):

```bash
# Wallet routing mode for agents and 0G inference
#   pk            — env WALLET_PRIVATE_KEY for both agent tools and 0G payments (default; current behavior)
#   privy         — per-user Privy wallet for both agent tools and 0G payments
#   privy_and_pk  — per-user Privy wallet for agent tools; env WALLET_PRIVATE_KEY for 0G payments
WALLET_MODE=pk
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no callers of `WALLET_MODE` yet, so adding the field is purely additive).

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat(env): add WALLET_MODE schema (pk|privy|privy_and_pk)"
```

---

## Task 2: Refactor `buildZeroGBroker` to take a pre-built signer

**Files:**
- Modify: `src/ai/zerog-broker/zerog-broker-factory.ts`
- Modify: `src/ai/zerog-broker/bootstrap-cli.ts`
- Modify: `src/worker.ts` (one call site)

The existing `buildZeroGBroker(env)` signature constructs an `ethers.Wallet` internally from `WALLET_PRIVATE_KEY`. After this task it accepts a pre-built `ethers.Signer` so both env-pk and `PrivySigner` flows can reuse it.

- [ ] **Step 1: Replace `buildZeroGBroker` signature**

Replace the body of `src/ai/zerog-broker/zerog-broker-factory.ts` (keep the `ZeroGBroker` type alias and the existing `ZeroGBrokerFactory.createBrokerFromSigner` static):

```ts
import { JsonRpcProvider, Wallet, type AbstractSigner, type Signer } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';
import { ZEROG_NETWORKS, type ZeroGNetworkName } from '../../constants';

export interface BrokerInputs {
  signer: Signer;
  ZEROG_NETWORK: ZeroGNetworkName;
}

export type ZeroGBroker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export async function buildZeroGBroker(inputs: BrokerInputs): Promise<{
  broker: ZeroGBroker;
  walletAddress: `0x${string}`;
}> {
  const broker = await createZGComputeNetworkBroker(inputs.signer as any);
  const walletAddress = (await inputs.signer.getAddress()) as `0x${string}`;
  return { broker, walletAddress };
}

export function buildZeroGProvider(network: ZeroGNetworkName): JsonRpcProvider {
  return new JsonRpcProvider(ZEROG_NETWORKS[network].rpcUrl);
}

export function buildEnvPkZeroGSigner(privateKey: string, network: ZeroGNetworkName): Wallet {
  return new Wallet(privateKey, buildZeroGProvider(network));
}

export class ZeroGBrokerFactory {
  static async createBrokerFromSigner(signer: AbstractSigner): Promise<ZeroGBroker> {
    return createZGComputeNetworkBroker(signer as any);
  }
}
```

Notes:
- `buildZeroGProvider` and `buildEnvPkZeroGSigner` are small helpers used by the bootstrap CLI, the worker, and `WalletFactory` — single source for 0G provider construction.
- The async `getAddress()` call replaces the sync `wallet.address` access from the old impl.

- [ ] **Step 2: Update bootstrap CLI call site**

In `src/ai/zerog-broker/bootstrap-cli.ts`, find the line:

```ts
  const { broker, walletAddress } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: env.ZEROG_NETWORK,
  });
```

Replace with:

```ts
  const signer = buildEnvPkZeroGSigner(env.WALLET_PRIVATE_KEY, env.ZEROG_NETWORK);
  const { broker, walletAddress } = await buildZeroGBroker({
    signer,
    ZEROG_NETWORK: env.ZEROG_NETWORK,
  });
```

Add the import at the top of the file:

```ts
import { buildZeroGBroker, buildEnvPkZeroGSigner } from './zerog-broker-factory';
```

(replacing the existing `buildZeroGBroker` import line).

- [ ] **Step 3: Update worker call site**

In `src/worker.ts`, inside `buildLLM(env)`, find the line:

```ts
  const { broker } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: state.network,
  });
```

Replace with:

```ts
  const signer = buildEnvPkZeroGSigner(env.WALLET_PRIVATE_KEY, state.network);
  const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: state.network });
```

Add to the existing import line for `zerog-broker-factory`:

```ts
import { buildZeroGBroker, buildEnvPkZeroGSigner } from './ai/zerog-broker/zerog-broker-factory';
```

(`buildLLM` will be removed entirely in Task 7 — for now keep it working so intermediate commits compile.)

- [ ] **Step 4: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Run live test for bootstrap (read-only path only)**

The bootstrap CLI itself is interactive and costs OG. Verify via typecheck only — no live test runs the bootstrap path.

Run: `npm test -- src/ai/zerog-broker/zerog-bootstrap-store.live.test.ts`
Expected: PASS (the store tests don't construct a broker; they only verify file IO).

- [ ] **Step 6: Commit**

```bash
git add src/ai/zerog-broker/zerog-broker-factory.ts src/ai/zerog-broker/bootstrap-cli.ts src/worker.ts
git commit -m "refactor(zerog): buildZeroGBroker takes pre-built ethers.Signer"
```

---

## Task 3: `WalletFactory` — new ctor + mode dispatch + async `forAgent`

**Files:**
- Modify: `src/wallet/factory/wallet-factory.ts`
- Modify: `src/wallet/factory/wallet-factory.live.test.ts`
- Modify: `src/agent-runner/agent-runner.ts` (await call site)
- Modify: `src/agent-runner/agent-runner.live.test.ts` (ctor)
- Modify: `src/agent-worker/agent-orchestrator.live.test.ts` (ctor)
- Modify: `src/worker.ts` (ctor)

`WalletFactory` is rewritten in this task. It now:
- Takes a `walletMode`, optional `PrivyClient`, `publicClient` (Unichain), `userWallets` repo, plus 0G provider/chainId for `forZerogPayments` (added in Task 4).
- `forAgent(agent)` is async and dispatches by `walletMode`.
- Caches Wallet instances per `agentId` (Promise cache to handle concurrent first calls).

`forZerogPayments` is added in Task 4 — keep this task focused on the constructor + `forAgent`.

- [ ] **Step 1: Rewrite `wallet-factory.ts` (ctor + forAgent only)**

Replace the contents of `src/wallet/factory/wallet-factory.ts`:

```ts
import type { PrivyClient } from '@privy-io/server-auth';
import type { PublicClient } from 'viem';
import type { JsonRpcProvider } from 'ethers';
import type { AgentConfig } from '../../database/types';
import type { TransactionRepository } from '../../database/repositories/transaction-repository';
import type { UserWalletRepository } from '../../database/repositories/user-wallet-repository';
import type { Wallet } from '../wallet';
import { RealWallet, type RealWalletEnv } from '../real/real-wallet';
import { DryRunWallet, type DryRunWalletEnv } from '../dry-run/dry-run-wallet';
import { PrivyServerWallet } from '../privy/privy-server-wallet';

export type WalletMode = 'pk' | 'privy' | 'privy_and_pk';

export type WalletFactoryEnv = RealWalletEnv & DryRunWalletEnv;

export interface WalletFactoryDeps {
  env: WalletFactoryEnv;
  walletMode: WalletMode;
  transactions: TransactionRepository;
  userWallets: UserWalletRepository;
  privy: PrivyClient | null;
  publicClient: PublicClient;
  zerogProvider: JsonRpcProvider;
  zerogChainId: number;
}

export class WalletFactory {
  private readonly cache = new Map<string, Promise<Wallet>>();

  constructor(private readonly deps: WalletFactoryDeps) {}

  async forAgent(agent: AgentConfig): Promise<Wallet> {
    const cached = this.cache.get(agent.id);
    if (cached) return cached;
    const promise = this.build(agent);
    this.cache.set(agent.id, promise);
    return promise;
  }

  private async build(agent: AgentConfig): Promise<Wallet> {
    if (agent.dryRun) {
      return new DryRunWallet(agent, this.deps.transactions, this.deps.env);
    }
    switch (this.deps.walletMode) {
      case 'pk':
        return new RealWallet(this.deps.env);
      case 'privy':
      case 'privy_and_pk': {
        const privy = this.requirePrivy();
        const uw = await this.deps.userWallets.findPrimaryByUser(agent.userId);
        if (!uw) {
          throw new Error(
            `agent ${agent.id} (user ${agent.userId}) has no primary UserWallet — provision one via POST /users/me/wallets`,
          );
        }
        return new PrivyServerWallet(privy, uw, this.deps.publicClient);
      }
    }
  }

  private requirePrivy(): PrivyClient {
    if (!this.deps.privy) {
      throw new Error(
        `WalletFactory: walletMode=${this.deps.walletMode} requires a PrivyClient — set PRIVY_APP_ID and PRIVY_APP_SECRET`,
      );
    }
    return this.deps.privy;
  }
}
```

- [ ] **Step 2: Make `AgentRunner.run` await `forAgent`**

In `src/agent-runner/agent-runner.ts`, find:

```ts
      const wallet = this.walletFactory.forAgent(agent);
```

Replace with:

```ts
      const wallet = await this.walletFactory.forAgent(agent);
```

- [ ] **Step 3: Update `WalletFactory` ctor calls in tests + worker**

`src/agent-runner/agent-runner.live.test.ts` — find every `new WalletFactory(TEST_ENV, db.transactions)` call and replace with the helper below. Add this helper near the top of the file (after the `TEST_ENV` constant):

```ts
import { JsonRpcProvider } from 'ethers';
import { createPublicClient, http } from 'viem';
import { unichain } from 'viem/chains';
import { ZEROG_NETWORKS } from '../constants';

const TEST_PUBLIC_CLIENT = createPublicClient({ chain: unichain, transport: http() });
const TEST_ZEROG_PROVIDER = new JsonRpcProvider(ZEROG_NETWORKS.testnet.rpcUrl);

function makeTestWalletFactory(db: PrismaDatabase): WalletFactory {
  return new WalletFactory({
    env: TEST_ENV,
    walletMode: 'pk',
    transactions: db.transactions,
    userWallets: db.userWallets,
    privy: null,
    publicClient: TEST_PUBLIC_CLIENT,
    zerogProvider: TEST_ZEROG_PROVIDER,
    zerogChainId: ZEROG_NETWORKS.testnet.chainId,
  });
}
```

Then replace every occurrence of:

```ts
walletFactory = new WalletFactory(TEST_ENV, db.transactions);
```

with:

```ts
walletFactory = makeTestWalletFactory(db);
```

(This file currently has multiple `new WalletFactory(...)` constructions — update all of them.)

`src/agent-worker/agent-orchestrator.live.test.ts` — apply the same helper pattern. Place the helper alongside the existing `TEST_ENV` constant.

`src/worker.ts` — find:

```ts
  const walletFactory = new WalletFactory(env, db.transactions);
```

Replace with (also add necessary imports):

```ts
  const zerogProvider = buildZeroGProvider(env.ZEROG_NETWORK);
  const walletFactory = new WalletFactory({
    env,
    walletMode: env.WALLET_MODE,
    transactions: db.transactions,
    userWallets: db.userWallets,
    privy: env.WALLET_MODE === 'pk' ? null : new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET),
    publicClient: createPublicClient({ chain: unichain, transport: http(env.UNICHAIN_RPC_URL) }),
    zerogProvider,
    zerogChainId: ZEROG_NETWORKS[env.ZEROG_NETWORK].chainId,
  });
```

Imports to add at the top of `src/worker.ts`:

```ts
import { createPublicClient, http } from 'viem';
import { unichain } from 'viem/chains';
import { ZEROG_NETWORKS } from './constants';
import { buildZeroGProvider } from './ai/zerog-broker/zerog-broker-factory';
```

(Note: `worker.ts` already imports `PrivyClient`. There's also an existing `privyClient` constant later in `main()` used by the treasury — reuse that one if present, otherwise keep them separate. Audit the diff before committing.)

- [ ] **Step 4: Update `wallet-factory.live.test.ts`**

Replace the contents of `src/wallet/factory/wallet-factory.live.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { createPublicClient, http } from 'viem';
import { unichain } from 'viem/chains';
import { PrivyClient } from '@privy-io/server-auth';
import { WalletFactory } from './wallet-factory';
import { RealWallet } from '../real/real-wallet';
import { DryRunWallet } from '../dry-run/dry-run-wallet';
import { PrivyServerWallet } from '../privy/privy-server-wallet';
import { PrismaTransactionRepository } from '../../database/prisma-database/prisma-transaction-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { getTestPrisma, truncateAll } from '../../database/prisma-database/test-helpers';
import { ZEROG_NETWORKS } from '../../constants';
import type { AgentConfig, User, UserWallet } from '../../database/types';
import { randomUUID } from 'node:crypto';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = {
  WALLET_PRIVATE_KEY: TEST_KEY,
  ALCHEMY_API_KEY: 'unused-for-this-test',
};
const PUBLIC_CLIENT = createPublicClient({ chain: unichain, transport: http() });
const ZEROG_PROVIDER = new JsonRpcProvider(ZEROG_NETWORKS.testnet.rpcUrl);
const ZEROG_CHAIN_ID = ZEROG_NETWORKS.testnet.chainId;

function makeAgent(opts: { id: string; userId: string; dryRun: boolean }): AgentConfig {
  return {
    id: opts.id,
    userId: opts.userId,
    name: opts.id,
    running: true,
    intervalMs: 60_000,
    prompt: 'test',
    dryRun: opts.dryRun,
    dryRunSeedBalances: opts.dryRun ? { native: '0' } : undefined,
    allowedTokens: [],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

async function seedUserWithWallet(
  users: PrismaUserRepository,
  wallets: PrismaUserWalletRepository,
  privyDid: string,
): Promise<{ user: User; uw: UserWallet }> {
  const user: User = { id: randomUUID(), privyDid, createdAt: Date.now() };
  await users.upsertByPrivyDid(user);
  const uw: UserWallet = {
    id: randomUUID(),
    userId: user.id,
    privyWalletId: `privy-wallet-${user.id}`,
    walletAddress: `0x${'ab'.repeat(20)}`,
    isPrimary: true,
    createdAt: Date.now(),
  };
  await wallets.insert(uw);
  return { user, uw };
}

describe('WalletFactory (live)', () => {
  const prisma = getTestPrisma();
  let txRepo: PrismaTransactionRepository;
  let userWallets: PrismaUserWalletRepository;
  let users: PrismaUserRepository;

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    txRepo = new PrismaTransactionRepository(prisma);
    userWallets = new PrismaUserWalletRepository(prisma);
    users = new PrismaUserRepository(prisma);
  });

  function build(walletMode: 'pk' | 'privy' | 'privy_and_pk', privy: PrivyClient | null = null): WalletFactory {
    return new WalletFactory({
      env: TEST_ENV,
      walletMode,
      transactions: txRepo,
      userWallets,
      privy,
      publicClient: PUBLIC_CLIENT,
      zerogProvider: ZEROG_PROVIDER,
      zerogChainId: ZEROG_CHAIN_ID,
    });
  }

  describe('forAgent', () => {
    it('pk mode: returns RealWallet for live agent', async () => {
      const factory = build('pk');
      const w = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      expect(w).toBeInstanceOf(RealWallet);
    });

    it('any mode: returns DryRunWallet when agent.dryRun=true', async () => {
      const factory = build('privy', new PrivyClient('app-id', 'app-secret'));
      const w = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: true }));
      expect(w).toBeInstanceOf(DryRunWallet);
    });

    it('privy mode: returns PrivyServerWallet using primary UserWallet', async () => {
      const { user, uw } = await seedUserWithWallet(users, userWallets, 'did:privy:test');
      const privy = new PrivyClient('app-id-stub', 'app-secret-stub');
      const factory = build('privy', privy);
      const w = await factory.forAgent(makeAgent({ id: 'a1', userId: user.id, dryRun: false }));
      expect(w).toBeInstanceOf(PrivyServerWallet);
      expect(w.getAddress().toLowerCase()).toBe(uw.walletAddress.toLowerCase());
      console.log('[wallet-factory] privy → wallet address:', w.getAddress());
    });

    it('privy_and_pk mode: returns PrivyServerWallet for tools (same as privy)', async () => {
      const { user } = await seedUserWithWallet(users, userWallets, 'did:privy:test2');
      const privy = new PrivyClient('app-id-stub', 'app-secret-stub');
      const factory = build('privy_and_pk', privy);
      const w = await factory.forAgent(makeAgent({ id: 'a2', userId: user.id, dryRun: false }));
      expect(w).toBeInstanceOf(PrivyServerWallet);
    });

    it('privy mode: throws when agent.userId has no primary UserWallet', async () => {
      const privy = new PrivyClient('app-id-stub', 'app-secret-stub');
      const factory = build('privy', privy);
      await expect(
        factory.forAgent(makeAgent({ id: 'a1', userId: 'unknown-user', dryRun: false })),
      ).rejects.toThrow(/no primary UserWallet/);
    });

    it('privy mode: throws when no PrivyClient is provided', async () => {
      const factory = build('privy', null);
      await expect(
        factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false })),
      ).rejects.toThrow(/requires a PrivyClient/);
    });

    it('caches one wallet per agent id (same instance on repeat calls)', async () => {
      const factory = build('pk');
      const a1First = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      const a1Second = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      const a2 = await factory.forAgent(makeAgent({ id: 'a2', userId: 'u1', dryRun: false }));
      expect(a1First).toBe(a1Second);
      expect(a1First).not.toBe(a2);
    });
  });
});
```

- [ ] **Step 5: Run live tests**

Run: `npm test -- src/wallet/factory/wallet-factory.live.test.ts`
Expected: PASS. The test requires `TEST_DATABASE_URL`; it will fail loudly otherwise.

- [ ] **Step 6: Run typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/wallet/factory/wallet-factory.ts src/wallet/factory/wallet-factory.live.test.ts \
        src/agent-runner/agent-runner.ts src/agent-runner/agent-runner.live.test.ts \
        src/agent-worker/agent-orchestrator.live.test.ts src/worker.ts
git commit -m "feat(wallet): WalletFactory dispatches forAgent by WALLET_MODE"
```

---

## Task 4: `WalletFactory.forZerogPayments`

**Files:**
- Modify: `src/wallet/factory/wallet-factory.ts`
- Modify: `src/wallet/factory/wallet-factory.live.test.ts`

Adds the second factory method. Singleton in `pk`/`privy_and_pk`; per-user `PrivySigner` in `privy`. Returns `{ signer, address }` so cache keys are sync.

- [ ] **Step 1: Add `forZerogPayments` to `WalletFactory`**

Append the following to the `WalletFactory` class in `src/wallet/factory/wallet-factory.ts`:

```ts
import { Wallet as EthersWallet, type Signer } from 'ethers';
import { PrivySigner } from '../privy/privy-signer';

export interface ZeroGSignerHandle {
  signer: Signer;
  address: string;
}
```

Add fields to the class:

```ts
  private envPkZeroGSigner: ZeroGSignerHandle | null = null;
  private readonly zerogSignerByUser = new Map<string, ZeroGSignerHandle>();
```

Add the method:

```ts
  async forZerogPayments(agent: AgentConfig): Promise<ZeroGSignerHandle> {
    switch (this.deps.walletMode) {
      case 'pk':
      case 'privy_and_pk':
        return this.envPkSigner();
      case 'privy':
        return this.privyZeroGSigner(agent);
    }
  }

  private envPkSigner(): ZeroGSignerHandle {
    if (this.envPkZeroGSigner) return this.envPkZeroGSigner;
    const wallet = new EthersWallet(this.deps.env.WALLET_PRIVATE_KEY, this.deps.zerogProvider);
    const handle: ZeroGSignerHandle = { signer: wallet, address: wallet.address };
    this.envPkZeroGSigner = handle;
    return handle;
  }

  private async privyZeroGSigner(agent: AgentConfig): Promise<ZeroGSignerHandle> {
    const cached = this.zerogSignerByUser.get(agent.userId);
    if (cached) return cached;
    const privy = this.requirePrivy();
    const uw = await this.deps.userWallets.findPrimaryByUser(agent.userId);
    if (!uw) {
      throw new Error(
        `agent ${agent.id} (user ${agent.userId}) has no primary UserWallet — provision one via POST /users/me/wallets`,
      );
    }
    const signer = new PrivySigner(
      privy,
      uw.privyWalletId,
      uw.walletAddress,
      this.deps.zerogChainId,
      this.deps.zerogProvider,
    );
    const handle: ZeroGSignerHandle = { signer, address: uw.walletAddress };
    this.zerogSignerByUser.set(agent.userId, handle);
    return handle;
  }
```

- [ ] **Step 2: Add tests**

Append to `describe('WalletFactory (live)', () => { ... })` in `src/wallet/factory/wallet-factory.live.test.ts`:

```ts
  describe('forZerogPayments', () => {
    it('pk mode: returns env-pk signer (singleton across calls)', async () => {
      const factory = build('pk');
      const a1 = await factory.forZerogPayments(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      const a2 = await factory.forZerogPayments(makeAgent({ id: 'a2', userId: 'u2', dryRun: false }));
      expect(a1).toBe(a2);
      expect(a1.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      console.log('[wallet-factory] pk zerog signer address:', a1.address);
    });

    it('privy_and_pk mode: returns env-pk signer (same singleton as pk)', async () => {
      const { user } = await seedUserWithWallet(users, userWallets, 'did:privy:t3');
      const factory = build('privy_and_pk', new PrivyClient('id', 'secret'));
      const handle = await factory.forZerogPayments(makeAgent({ id: 'a1', userId: user.id, dryRun: false }));
      const expected = new EthersWallet(TEST_KEY).address;
      expect(handle.address.toLowerCase()).toBe(expected.toLowerCase());
    });

    it('privy mode: returns PrivySigner for the user wallet, cached per-user', async () => {
      const { user, uw } = await seedUserWithWallet(users, userWallets, 'did:privy:t4');
      const privy = new PrivyClient('id', 'secret');
      const factory = build('privy', privy);
      const a1 = await factory.forZerogPayments(makeAgent({ id: 'a1', userId: user.id, dryRun: false }));
      const a2 = await factory.forZerogPayments(makeAgent({ id: 'a2', userId: user.id, dryRun: false }));
      expect(a1).toBe(a2);                                      // cached per-user
      expect(a1.address.toLowerCase()).toBe(uw.walletAddress.toLowerCase());
      expect(a1.signer).toBeInstanceOf(PrivySigner);
    });

    it('privy mode: throws when user has no primary UserWallet', async () => {
      const factory = build('privy', new PrivyClient('id', 'secret'));
      await expect(
        factory.forZerogPayments(makeAgent({ id: 'a1', userId: 'unknown', dryRun: false })),
      ).rejects.toThrow(/no primary UserWallet/);
    });
  });
```

Add this import alongside existing imports at the top of the test file:

```ts
import { Wallet as EthersWallet } from 'ethers';
import { PrivySigner } from '../privy/privy-signer';
```

- [ ] **Step 3: Run tests**

Run: `npm test -- src/wallet/factory/wallet-factory.live.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/wallet/factory/wallet-factory.ts src/wallet/factory/wallet-factory.live.test.ts
git commit -m "feat(wallet): forZerogPayments dispatches by WALLET_MODE"
```

---

## Task 5: `LLMClientFactory`

**Files:**
- Create: `src/ai/chat-model/llm-client-factory.ts`
- Create: `src/ai/chat-model/llm-client-factory.live.test.ts`

- [ ] **Step 1: Write the new factory**

Create `src/ai/chat-model/llm-client-factory.ts`:

```ts
import type { LLMClient } from '../../agent-runner/llm-client';
import type { AgentConfig } from '../../database/types';
import type { WalletFactory } from '../../wallet/factory/wallet-factory';
import type { ZeroGBootstrapState } from '../zerog-broker/types';
import { buildZeroGBroker } from '../zerog-broker/zerog-broker-factory';
import { ZeroGLLMClient } from './zerog-llm-client';
import { StubLLMClient } from '../../agent-runner/stub-llm-client';

export class LLMClientFactory {
  private readonly cache = new Map<string, Promise<LLMClient>>();
  private readonly stub: LLMClient | null;

  constructor(
    private readonly walletFactory: WalletFactory,
    private readonly bootstrapState: ZeroGBootstrapState | null,
  ) {
    this.stub = bootstrapState ? null : new StubLLMClient();
  }

  modelName(): string {
    return this.bootstrapState?.model ?? new StubLLMClient().modelName();
  }

  async forAgent(agent: AgentConfig): Promise<LLMClient> {
    if (this.stub) return this.stub;
    const handle = await this.walletFactory.forZerogPayments(agent);
    const cached = this.cache.get(handle.address);
    if (cached) return cached;
    const promise = this.build(handle.signer);
    this.cache.set(handle.address, promise);
    return promise;
  }

  private async build(signer: Awaited<ReturnType<WalletFactory['forZerogPayments']>>['signer']): Promise<LLMClient> {
    const state = this.bootstrapState!;
    const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: state.network });
    return new ZeroGLLMClient({
      broker,
      providerAddress: state.providerAddress,
      serviceUrl: state.serviceUrl,
      model: state.model,
    });
  }
}
```

- [ ] **Step 2: Write the live test**

Create `src/ai/chat-model/llm-client-factory.live.test.ts`:

```ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { createPublicClient, http } from 'viem';
import { unichain } from 'viem/chains';
import { LLMClientFactory } from './llm-client-factory';
import { StubLLMClient } from '../../agent-runner/stub-llm-client';
import { WalletFactory } from '../../wallet/factory/wallet-factory';
import { PrismaTransactionRepository } from '../../database/prisma-database/prisma-transaction-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { getTestPrisma, truncateAll } from '../../database/prisma-database/test-helpers';
import { ZEROG_NETWORKS } from '../../constants';
import type { AgentConfig } from '../../database/types';
import type { ZeroGBootstrapState } from '../zerog-broker/types';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = { WALLET_PRIVATE_KEY: TEST_KEY, ALCHEMY_API_KEY: 'unused' };
const PUBLIC_CLIENT = createPublicClient({ chain: unichain, transport: http() });
const ZEROG_PROVIDER = new JsonRpcProvider(ZEROG_NETWORKS.testnet.rpcUrl);

function makeAgent(id: string, userId: string): AgentConfig {
  return {
    id,
    userId,
    name: id,
    running: true,
    intervalMs: 60_000,
    prompt: 'test',
    dryRun: false,
    allowedTokens: [],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

const FAKE_BOOTSTRAP: ZeroGBootstrapState = {
  network: 'testnet',
  providerAddress: '0xf07240Efa67755B5311bc75784a061eDB47165Dd',
  serviceUrl: 'https://example.invalid/v1/proxy',
  model: 'llama-3.3-70b-instruct',
  acknowledgedAt: 1,
  fundedAt: 1,
  fundAmountOG: 0,
};

describe('LLMClientFactory (live)', () => {
  const prisma = getTestPrisma();

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  function buildWallet(): WalletFactory {
    return new WalletFactory({
      env: TEST_ENV,
      walletMode: 'pk',
      transactions: new PrismaTransactionRepository(prisma),
      userWallets: new PrismaUserWalletRepository(prisma),
      privy: null,
      publicClient: PUBLIC_CLIENT,
      zerogProvider: ZEROG_PROVIDER,
      zerogChainId: ZEROG_NETWORKS.testnet.chainId,
    });
  }

  it('returns StubLLMClient when bootstrap state is null', async () => {
    const llmFactory = new LLMClientFactory(buildWallet(), null);
    const llm = await llmFactory.forAgent(makeAgent('a1', 'u1'));
    expect(llm).toBeInstanceOf(StubLLMClient);
  });

  it('caches one LLMClient per signer address (pk singleton → same instance for two agents)', async () => {
    const llmFactory = new LLMClientFactory(buildWallet(), FAKE_BOOTSTRAP);
    const a = await llmFactory.forAgent(makeAgent('a1', 'u1'));
    const b = await llmFactory.forAgent(makeAgent('a2', 'u2'));
    expect(a).toBe(b);
    console.log('[llm-factory] pk singleton cached across users:', a.modelName());
  });

  it('modelName reflects bootstrap state', () => {
    const llmFactory = new LLMClientFactory(buildWallet(), FAKE_BOOTSTRAP);
    expect(llmFactory.modelName()).toBe(FAKE_BOOTSTRAP.model);
  });
});
```

Note: this test does not exercise the `privy` mode caching path — that's covered in `wallet-factory.live.test.ts` via `forZerogPayments`. The `pk` singleton path is the only behavior unique to `LLMClientFactory`.

- [ ] **Step 3: Run live tests**

Run: `npm test -- src/ai/chat-model/llm-client-factory.live.test.ts`
Expected: PASS. The cache test calls `buildZeroGBroker` against `https://example.invalid` — broker construction is local-only (does not actually contact the URL until `inference.getRequestHeaders` is invoked), so this stays read-only.

If the test ever fails because broker construction reaches the network, replace `FAKE_BOOTSTRAP.serviceUrl` with the real testnet provider service URL from `db/zerog-bootstrap.json` and document the dependency at the top of the test.

- [ ] **Step 4: Commit**

```bash
git add src/ai/chat-model/llm-client-factory.ts src/ai/chat-model/llm-client-factory.live.test.ts
git commit -m "feat(ai): LLMClientFactory caches ZeroGLLMClient per signer address"
```

---

## Task 6: `AgentRunner` takes `LLMClientFactory`

**Files:**
- Modify: `src/agent-runner/agent-runner.ts`
- Modify: `src/agent-runner/agent-runner.live.test.ts`
- Modify: `src/agent-worker/agent-orchestrator.live.test.ts`

`AgentRunner` switches from holding a singleton `LLMClient` to resolving one per tick via `LLMClientFactory.forAgent`. The tool loop uses the resolved instance. Public API is otherwise unchanged.

- [ ] **Step 1: Update `AgentRunner` constructor + run()**

In `src/agent-runner/agent-runner.ts`:

Replace the constructor:

```ts
  constructor(
    private readonly db: Database,
    private readonly activityLog: AgentActivityLog,
    private readonly walletFactory: WalletFactory,
    private readonly llmFactory: LLMClientFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}
```

Replace the import line for `LLMClient`:

```ts
import type { ChatMessage, InvokeOptions, ToolCall, ToolDefinition, LLMClient } from './llm-client';
import type { LLMClientFactory } from '../ai/chat-model/llm-client-factory';
```

In `run()`, immediately after `await this.activityLog.tickStart(...)`, add:

```ts
      const llm = await this.llmFactory.forAgent(agent);
```

Then update `runToolLoop` to take `llm` as a parameter:

```ts
  private async runToolLoop(
    agent: AgentConfig,
    tickId: string,
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    toolByName: Map<string, AgentTool>,
    ctx: AgentToolContext,
    llm: LLMClient,
    options: InvokeOptions = {},
  ): Promise<void> {
```

Inside `runToolLoop`, replace every `this.llm.` with `llm.` (occurrences: `this.llm.modelName()` twice, `this.llm.invokeWithTools(...)` once).

Update the call site inside `run()`:

```ts
      await this.runToolLoop(agent, tickId, initialMessages, toolDefs, toolByName, ctx, llm, options);
```

- [ ] **Step 2: Update `agent-runner.live.test.ts` ctor calls**

Replace the existing `ScriptedLLMClient` setup so it's wrapped in a tiny inline `LLMClientFactory`-like double. Add a helper in the test file:

```ts
import type { LLMClientFactory } from '../ai/chat-model/llm-client-factory';

function asFactory(llm: LLMClient): LLMClientFactory {
  return {
    forAgent: async () => llm,
    modelName: () => llm.modelName(),
  } as unknown as LLMClientFactory;
}
```

Then replace every `new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry, ...)` with:

```ts
new AgentRunner(db, activityLog, walletFactory, asFactory(llm), toolRegistry, ...)
```

- [ ] **Step 3: Update `agent-orchestrator.live.test.ts` ctor calls**

Apply the same `asFactory(...)` helper pattern. Replace:

```ts
runner = new AgentRunner(db, activityLog, walletFactory, new StubLLMClient(), toolRegistry, clock);
```

with:

```ts
runner = new AgentRunner(db, activityLog, walletFactory, asFactory(new StubLLMClient()), toolRegistry, clock);
```

And similarly for the `failingRunner` ctor near line 176.

- [ ] **Step 4: Run live tests**

Run: `npm test -- src/agent-runner src/agent-worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-runner/agent-runner.ts src/agent-runner/agent-runner.live.test.ts src/agent-worker/agent-orchestrator.live.test.ts
git commit -m "feat(agent-runner): resolve LLMClient per tick via LLMClientFactory"
```

---

## Task 7: Worker wiring + bootstrap-cli note

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/ai/zerog-broker/bootstrap-cli.ts`

- [ ] **Step 1: Replace `buildLLM` with `LLMClientFactory` construction in `worker.ts`**

In `src/worker.ts`:

Remove the entire `buildLLM(env)` async helper function near the top of the file.

Remove the matching imports: `StubLLMClient`, `LLMClient`, `ZeroGBootstrapStore`, `silenceZeroGSdkNoise`, `ZeroGLLMClient`, `buildZeroGBroker`, `buildEnvPkZeroGSigner` — keep what's still needed and replace with the LLMClientFactory imports.

Imports needed after the change (delta from current top-of-file):

```ts
import { LLMClientFactory } from './ai/chat-model/llm-client-factory';
import { ZeroGBootstrapStore } from './ai/zerog-broker/zerog-bootstrap-store';
import { silenceZeroGSdkNoise } from './ai/zerog-broker/silence-sdk-noise';
import { buildZeroGProvider } from './ai/zerog-broker/zerog-broker-factory';
import { createPublicClient, http } from 'viem';
import { unichain } from 'viem/chains';
import { ZEROG_NETWORKS } from './constants';
```

Remove these imports if no longer referenced:

```ts
import { StubLLMClient } from './agent-runner/stub-llm-client';
import type { LLMClient } from './agent-runner/llm-client';
import { ZeroGLLMClient } from './ai/chat-model/zerog-llm-client';
```

Inside `main()`, replace this block:

```ts
  const walletFactory = new WalletFactory(env, db.transactions);
  const uniswap = new UniswapService(env, db);
  const llm = await buildLLM(env);
```

With:

```ts
  const bootstrapStore = new ZeroGBootstrapStore(env.DB_DIR);
  const bootstrapState = await bootstrapStore.load();
  if (bootstrapState && bootstrapState.network !== env.ZEROG_NETWORK) {
    console.warn(
      `[bootstrap] WARNING: zerog-bootstrap.json was funded on '${bootstrapState.network}' but env says '${env.ZEROG_NETWORK}'; using the file's network.`,
    );
  }
  if (!bootstrapState) {
    console.log('[bootstrap] no zerog-bootstrap.json; using StubLLMClient. Run `npm run zerog-bootstrap` to fund a 0G provider.');
  } else {
    silenceZeroGSdkNoise();
    console.log(`[bootstrap] 0G LLM ready — network=${bootstrapState.network} provider=${bootstrapState.providerAddress} model=${bootstrapState.model}`);
  }

  const zerogNetwork = bootstrapState?.network ?? env.ZEROG_NETWORK;
  const zerogProvider = buildZeroGProvider(zerogNetwork);
  const publicClient = createPublicClient({ chain: unichain, transport: http(env.UNICHAIN_RPC_URL) });
  const privyClient = env.WALLET_MODE === 'pk' ? null : new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);

  const walletFactory = new WalletFactory({
    env,
    walletMode: env.WALLET_MODE,
    transactions: db.transactions,
    userWallets: db.userWallets,
    privy: privyClient,
    publicClient,
    zerogProvider,
    zerogChainId: ZEROG_NETWORKS[zerogNetwork].chainId,
  });
  const uniswap = new UniswapService(env, db);
  const llmFactory = new LLMClientFactory(walletFactory, bootstrapState);
```

Update `console.log(\`[bootstrap] tools=...\`)` line to use `llmFactory`:

```ts
  console.log(`[bootstrap] tools=${toolRegistry.build().length} llm=${llmFactory.modelName()} walletMode=${env.WALLET_MODE}`);
```

Replace the `AgentRunner` construction:

```ts
  const runner = new AgentRunner(db, activityLog, walletFactory, llmFactory, toolRegistry);
```

The existing `privyClient` constant later in `main()` (used by treasury) — replace it with the variable already introduced above so we don't construct two `PrivyClient` instances:

```ts
  const treasuryWallet = new TreasuryWallet(env);
  const jaineSwap = new JaineSwapService(treasuryWallet);
  // ... existing code ...
  const treasuryService = new TreasuryService(
    env,
    db,
    treasuryServiceRedis,
    treasuryWallet,
    jaineSwap,
    privyClient!,  // treasury requires privy; if WALLET_MODE === 'pk' the operator must still provide PRIVY_* for treasury OR we throw here
    // ... unchanged ...
  );
```

(Audit `treasury-service.ts`'s `PrivyClient` usage. The current worker constructs one unconditionally; treasury depends on it. If treasury must always have Privy, throw at boot when `WALLET_MODE === 'pk'` and `PRIVY_APP_ID/SECRET` are still required by `loadEnv`. Since `loadEnv` already requires them, `privyClient` can stay non-null even in `pk` mode by always constructing it. Simpler: drop the `null` branch; always construct `PrivyClient`. Update accordingly.)

Final form for that line:

```ts
  const privyClient = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
```

And in the `WalletFactory` deps:

```ts
    privy: env.WALLET_MODE === 'pk' ? null : privyClient,
```

This keeps the `WalletFactory` contract honest (no Privy in `pk` mode) while reusing the single client elsewhere.

- [ ] **Step 2: Add bootstrap CLI note**

In `src/ai/zerog-broker/bootstrap-cli.ts`, add a single line to the existing CLI banner output (immediately after the `console.log(\`[zerog-bootstrap] network=...\`)` line near the top):

```ts
  console.log('[zerog-bootstrap] note: 0G ledger funding for Privy wallets is handled via the UI flow, not this script.');
```

- [ ] **Step 3: Build + typecheck**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Smoke — boot the worker against a local DB**

Run: `npm run db:reset && npm run start:worker`
Expected: bootstrap log line includes `walletMode=pk`. Worker ticks normally. Kill with ctrl-C.

- [ ] **Step 5: Smoke — boot in `privy_and_pk` mode**

Set `WALLET_MODE=privy_and_pk` in `.env` (temporarily) and rerun: `npm run start:worker`
Expected: bootstrap log shows `walletMode=privy_and_pk`. The seed agent ticks. If the seed agent's user has no primary `UserWallet`, expect a clear error in the activity log on first tick — confirming the loud-fail behavior.

Revert `.env` after the smoke.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/ai/zerog-broker/bootstrap-cli.ts
git commit -m "feat(worker): wire LLMClientFactory + WalletFactory mode dispatch"
```

---

## Task 8: Run full test suite

- [ ] **Step 1: Full test run**

Run: `npm test`
Expected: PASS for the full live + unit suite. The suite requires `TEST_DATABASE_URL` and a running Redis; it will fail loudly if either is missing.

- [ ] **Step 2: Final typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 3: No commit needed unless tests required fixups**

If any fixups were needed, commit them with a focused message. Otherwise the branch is ready for PR review.

---

## Risks + open considerations

- **`worker.ts` privy client construction:** the current code unconditionally constructs `new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET)` for the treasury. The plan reuses it and only conditionally passes it into `WalletFactory`. If a future change makes Privy creds optional in `pk` mode, the treasury's dependency must be revisited at the same time.
- **`forAgent` becoming async** is a public API change for any external caller. As of this branch, the only caller outside the test suite is `AgentRunner.run` which is updated in Task 3.
- **Cache invalidation:** mode flips, primary `UserWallet` rotation, and bootstrap state changes all require a worker restart. Documented in the spec.
- **Live test for `LLMClientFactory` cache** uses a fake `serviceUrl` and relies on `buildZeroGBroker` not making a network call during construction. If a future SDK release changes that, switch to a real bootstrap state from `db/zerog-bootstrap.json` (testnet) and document the dependency.

---

## Self-review (executed before handoff)

- **Spec coverage**:
  - WALLET_MODE env → Task 1.
  - Mode matrix (pk/privy/privy_and_pk for tools + 0G) → Task 3 (forAgent), Task 4 (forZerogPayments).
  - LLMClientFactory caching by signer address → Task 5.
  - AgentRunner takes factory → Task 6.
  - Worker wiring + bootstrap-cli note → Task 7.
  - Tests for all three modes → Tasks 3, 4, 5.
- **Placeholder scan**: none.
- **Type consistency**:
  - `forZerogPayments` returns `Promise<ZeroGSignerHandle>` everywhere it's referenced.
  - `LLMClientFactory.forAgent` returns `Promise<LLMClient>`; `AgentRunner` awaits it.
  - `buildZeroGBroker` takes `{ signer, ZEROG_NETWORK }` consistently in CLI, worker, and factory.
