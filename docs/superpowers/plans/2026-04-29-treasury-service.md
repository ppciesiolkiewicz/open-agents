# Treasury Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect USDC deposits to a treasury wallet on Unichain, swap them to native 0G via Across bridge + Jaine pool, send 0G to the user, then top up their 0G broker ledger — all automatically.

**Architecture:** A `TreasuryFundsWatcher` subscribes to Unichain USDC Transfer events via WebSocket and pushes events to a `treasury:events` Redis queue. A `TreasuryService` consumes that queue and orchestrates the full pipeline (bridge → swap → unwrap → send → broker top-up), recording each step in a `ZeroGPurchase` DB row. A new `POST /users/me/treasury/deposit` endpoint lets users initiate USDC transfers from their Privy wallet.

**Tech Stack:** viem (Unichain WebSocket), ethers.js v6 (0G chain), `@across-protocol/app-sdk` (bridge), Redis LPUSH/BRPOP (queue), Privy server SDK (sign 0G chain txs as user), Prisma/PostgreSQL (persistence).

---

## File Map

**Create:**
- `src/constants/treasury.ts` — fee BPS, Jaine addresses, Across addresses, queue name
- `src/treasury/treasury-wallet.ts` — treasury keypair; balance/send helpers for Unichain + 0G
- `src/treasury/jaine-swap-service.ts` — approve USDC.e, `exactInputSingle`, `W0G.withdraw`, send native 0G
- `src/treasury/across-bridge-service.ts` — bridge USDC Unichain→0G via Across, poll for fill
- `src/treasury/treasury-funds-watcher.ts` — viem `watchContractEvent` → Redis LPUSH
- `src/wallet/privy/privy-zerog-signer.ts` — ethers.js `AbstractSigner` backed by Privy (0G chain txs as user)
- `src/treasury/treasury-service.ts` — BRPOP consumer, orchestrates full pipeline
- `src/database/repositories/zero-g-purchase-repository.ts` — repository interface
- `src/database/prisma-database/prisma-zero-g-purchase-repository.ts` — Prisma impl
- `src/api-server/routes/treasury.ts` — `POST /users/me/treasury/deposit`

**Modify:**
- `src/config/env.ts` — add `TREASURY_WALLET_PRIVATE_KEY`; make `PRIVY_APP_ID`/`PRIVY_APP_SECRET` required (worker now needs them)
- `src/constants/tokens.ts` — add `USDCE_ON_ZEROG`, `W0G_ON_ZEROG`
- `src/constants/index.ts` — re-export treasury constants
- `src/database/types.ts` — add `ZeroGPurchase` type + `ZeroGPurchaseStatus`
- `src/database/repositories/user-wallet-repository.ts` — add `findByWalletAddress`
- `src/database/prisma-database/prisma-user-wallet-repository.ts` — implement `findByWalletAddress`
- `src/database/database.ts` — add `zeroGPurchases: ZeroGPurchaseRepository`
- `src/database/prisma-database/prisma-database.ts` — wire `PrismaZeroGPurchaseRepository`
- `prisma/schema.prisma` — add `ZeroGPurchase` model + `User.zeroGPurchases` relation
- `src/api-server/server.ts` — add treasury route + deps
- `src/server.ts` — wire treasury deps
- `src/worker.ts` — start/stop `TreasuryFundsWatcher` + `TreasuryService`
- `.env.example` — document `TREASURY_WALLET_PRIVATE_KEY`

---

## Task 1: Constants, env, and token definitions

**Files:**
- Create: `src/constants/treasury.ts`
- Modify: `src/config/env.ts`
- Modify: `src/constants/tokens.ts`
- Modify: `src/constants/index.ts`
- Modify: `.env.example`

- [ ] **Step 1.1: Add `TREASURY_WALLET_PRIVATE_KEY` to env schema and make Privy required**

Edit `src/config/env.ts`:

```typescript
import { z } from 'zod';

const envSchema = z.object({
  WALLET_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x-prefixed 32-byte hex'),

  TREASURY_WALLET_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x-prefixed 32-byte hex'),

  ALCHEMY_API_KEY: z.string().min(1),
  UNICHAIN_RPC_URL: z.string().url().optional(),

  ZEROG_NETWORK: z.enum(['mainnet', 'testnet']),
  ZEROG_PROVIDER_ADDRESS: z.string().min(1).optional(),

  COINGECKO_API_KEY: z.string().min(1),
  COINMARKETCAP_API_KEY: z.string().min(1),
  SERPER_API_KEY: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),

  DB_DIR: z.string().default('./db'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),

  REDIS_URL: z.string().url(),

  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  API_CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid env: ${issues}`);
  }
  return parsed.data;
}
```

- [ ] **Step 1.2: Create `src/constants/treasury.ts`**

```typescript
export const TREASURY_SERVICE_FEE_BPS = 1000;

export const JAINE_USDC_0G_POOL_ADDRESS = '0x961DA9B2FD03e04b088A90843a93E66f13112D0a' as const;
export const JAINE_SWAP_ROUTER_ADDRESS = '0x8b598a7c136215a95ba0282b4d832b9f9801f2e2' as const;
export const JAINE_POOL_FEE = 10000;

// Resolve from https://docs.across.to/reference/contract-addresses before first deploy
export const ACROSS_UNICHAIN_SPOKE_POOL_ADDRESS = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64' as const;

export const TREASURY_REDIS_QUEUE = 'treasury:events' as const;
```

- [ ] **Step 1.3: Add 0G chain token constants to `src/constants/tokens.ts`**

Append to the file:

```typescript
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

- [ ] **Step 1.4: Re-export from `src/constants/index.ts`**

Add this line to the existing exports:

```typescript
export * from './treasury.js';
```

- [ ] **Step 1.5: Update `.env.example`**

Add after `WALLET_PRIVATE_KEY=`:

```
TREASURY_WALLET_PRIVATE_KEY=
```

And change the Privy section from comment to required:

```
PRIVY_APP_ID=
PRIVY_APP_SECRET=
```

- [ ] **Step 1.6: Commit**

```bash
git add src/config/env.ts src/constants/treasury.ts src/constants/tokens.ts src/constants/index.ts .env.example
git commit -m "feat(treasury): add env var, token constants, and treasury constants"
```

---

## Task 2: ZeroGPurchase DB model + repositories

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/database/types.ts`
- Modify: `src/database/repositories/user-wallet-repository.ts`
- Modify: `src/database/prisma-database/prisma-user-wallet-repository.ts`
- Modify: `src/database/database.ts`
- Modify: `src/database/prisma-database/prisma-database.ts`
- Create: `src/database/repositories/zero-g-purchase-repository.ts`
- Create: `src/database/prisma-database/prisma-zero-g-purchase-repository.ts`

- [ ] **Step 2.1: Add `ZeroGPurchase` type and status to `src/database/types.ts`**

Append:

```typescript
export type ZeroGPurchaseStatus =
  | 'pending'
  | 'bridging'
  | 'swapping'
  | 'sending'
  | 'topping_up'
  | 'completed'
  | 'failed';

export interface ZeroGPurchase {
  id: string;
  userId: string;
  userWalletAddress: string;

  incomingTxHash: string;
  incomingUsdcAmount: string;

  serviceFeeUsdcAmount: string;
  swapInputUsdcAmount: string;

  bridgeTxHash?: string;
  bridgeGasCostWei?: string;

  swapTxHash?: string;
  swapInputUsdceAmount?: string;
  swapOutputW0gAmount?: string;
  swapGasCostWei?: string;

  unwrapTxHash?: string;
  unwrapGasCostWei?: string;
  unwrappedOgAmount?: string;

  sendTxHash?: string;
  sendGasCostWei?: string;
  ogAmountSentToUser?: string;

  ledgerTopUpTxHash?: string;
  ledgerTopUpGasCostWei?: string;

  status: ZeroGPurchaseStatus;
  errorMessage?: string;

  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2.2: Add `ZeroGPurchase` model to `prisma/schema.prisma`**

Add `zeroGPurchases` relation to the `User` model:

```prisma
model User {
  id          String   @id
  privyDid    String   @unique
  email       String?
  createdAt   BigInt

  wallets          UserWallet[]
  agents           Agent[]
  zeroGPurchases   ZeroGPurchase[]
}
```

Append new model at the end of the file:

```prisma
model ZeroGPurchase {
  id                    String   @id @default(uuid())
  userId                String
  user                  User     @relation(fields: [userId], references: [id])
  userWalletAddress     String

  incomingTxHash        String   @unique
  incomingUsdcAmount    BigInt

  serviceFeeUsdcAmount  BigInt
  swapInputUsdcAmount   BigInt

  bridgeTxHash          String?
  bridgeGasCostWei      BigInt?

  swapTxHash            String?
  swapInputUsdceAmount  BigInt?
  swapOutputW0gAmount   BigInt?
  swapGasCostWei        BigInt?

  unwrapTxHash          String?
  unwrapGasCostWei      BigInt?
  unwrappedOgAmount     BigInt?

  sendTxHash            String?
  sendGasCostWei        BigInt?
  ogAmountSentToUser    BigInt?

  ledgerTopUpTxHash     String?
  ledgerTopUpGasCostWei BigInt?

  status        String
  errorMessage  String?

  createdAt  BigInt
  updatedAt  BigInt

  @@index([userId])
  @@index([userWalletAddress])
}
```

- [ ] **Step 2.3: Run migration**

```bash
npm run db:migrate
```

Expected output: `The following migration(s) have been created and applied: migrations/YYYYMMDDHHMMSS_add_zero_g_purchase`

- [ ] **Step 2.4: Add `findByWalletAddress` to `src/database/repositories/user-wallet-repository.ts`**

```typescript
import type { UserWallet } from '../types';

export interface UserWalletRepository {
  insert(uw: UserWallet): Promise<void>;
  findById(id: string): Promise<UserWallet | null>;
  findPrimaryByUser(userId: string): Promise<UserWallet | null>;
  listByUser(userId: string): Promise<UserWallet[]>;
  findByPrivyWalletId(privyWalletId: string): Promise<UserWallet | null>;
  findByWalletAddress(address: string): Promise<UserWallet | null>;
}
```

- [ ] **Step 2.5: Implement `findByWalletAddress` in `src/database/prisma-database/prisma-user-wallet-repository.ts`**

Add this method to the class (read the file first, then append the method before the closing brace):

```typescript
async findByWalletAddress(address: string): Promise<UserWallet | null> {
  const row = await this.prisma.userWallet.findFirst({
    where: { walletAddress: address },
  });
  return row ? userWalletRowToDomain(row) : null;
}
```

- [ ] **Step 2.6: Create `src/database/repositories/zero-g-purchase-repository.ts`**

```typescript
import type { ZeroGPurchase, ZeroGPurchaseStatus } from '../types.js';

export interface ZeroGPurchaseRepository {
  insert(purchase: ZeroGPurchase): Promise<void>;
  findById(id: string): Promise<ZeroGPurchase | null>;
  findByIncomingTxHash(txHash: string): Promise<ZeroGPurchase | null>;
  listByUser(userId: string): Promise<ZeroGPurchase[]>;
  update(id: string, patch: Partial<Omit<ZeroGPurchase, 'id' | 'userId' | 'createdAt'>>): Promise<void>;
}
```

- [ ] **Step 2.7: Create `src/database/prisma-database/prisma-zero-g-purchase-repository.ts`**

```typescript
import type { PrismaClient } from '@prisma/client';
import type { ZeroGPurchaseRepository } from '../repositories/zero-g-purchase-repository.js';
import type { ZeroGPurchase, ZeroGPurchaseStatus } from '../types.js';

function rowToDomain(row: any): ZeroGPurchase {
  return {
    id: row.id,
    userId: row.userId,
    userWalletAddress: row.userWalletAddress,
    incomingTxHash: row.incomingTxHash,
    incomingUsdcAmount: row.incomingUsdcAmount.toString(),
    serviceFeeUsdcAmount: row.serviceFeeUsdcAmount.toString(),
    swapInputUsdcAmount: row.swapInputUsdcAmount.toString(),
    bridgeTxHash: row.bridgeTxHash ?? undefined,
    bridgeGasCostWei: row.bridgeGasCostWei?.toString(),
    swapTxHash: row.swapTxHash ?? undefined,
    swapInputUsdceAmount: row.swapInputUsdceAmount?.toString(),
    swapOutputW0gAmount: row.swapOutputW0gAmount?.toString(),
    swapGasCostWei: row.swapGasCostWei?.toString(),
    unwrapTxHash: row.unwrapTxHash ?? undefined,
    unwrapGasCostWei: row.unwrapGasCostWei?.toString(),
    unwrappedOgAmount: row.unwrappedOgAmount?.toString(),
    sendTxHash: row.sendTxHash ?? undefined,
    sendGasCostWei: row.sendGasCostWei?.toString(),
    ogAmountSentToUser: row.ogAmountSentToUser?.toString(),
    ledgerTopUpTxHash: row.ledgerTopUpTxHash ?? undefined,
    ledgerTopUpGasCostWei: row.ledgerTopUpGasCostWei?.toString(),
    status: row.status as ZeroGPurchaseStatus,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export class PrismaZeroGPurchaseRepository implements ZeroGPurchaseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(purchase: ZeroGPurchase): Promise<void> {
    await this.prisma.zeroGPurchase.create({
      data: {
        id: purchase.id,
        userId: purchase.userId,
        userWalletAddress: purchase.userWalletAddress,
        incomingTxHash: purchase.incomingTxHash,
        incomingUsdcAmount: BigInt(purchase.incomingUsdcAmount),
        serviceFeeUsdcAmount: BigInt(purchase.serviceFeeUsdcAmount),
        swapInputUsdcAmount: BigInt(purchase.swapInputUsdcAmount),
        status: purchase.status,
        createdAt: BigInt(purchase.createdAt),
        updatedAt: BigInt(purchase.updatedAt),
      },
    });
  }

  async findById(id: string): Promise<ZeroGPurchase | null> {
    const row = await this.prisma.zeroGPurchase.findUnique({ where: { id } });
    return row ? rowToDomain(row) : null;
  }

  async findByIncomingTxHash(txHash: string): Promise<ZeroGPurchase | null> {
    const row = await this.prisma.zeroGPurchase.findUnique({ where: { incomingTxHash: txHash } });
    return row ? rowToDomain(row) : null;
  }

  async listByUser(userId: string): Promise<ZeroGPurchase[]> {
    const rows = await this.prisma.zeroGPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(rowToDomain);
  }

  async update(id: string, patch: Partial<Omit<ZeroGPurchase, 'id' | 'userId' | 'createdAt'>>): Promise<void> {
    const data: Record<string, unknown> = { updatedAt: BigInt(Date.now()) };
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage;
    if (patch.bridgeTxHash !== undefined) data.bridgeTxHash = patch.bridgeTxHash;
    if (patch.bridgeGasCostWei !== undefined) data.bridgeGasCostWei = BigInt(patch.bridgeGasCostWei);
    if (patch.swapTxHash !== undefined) data.swapTxHash = patch.swapTxHash;
    if (patch.swapInputUsdceAmount !== undefined) data.swapInputUsdceAmount = BigInt(patch.swapInputUsdceAmount);
    if (patch.swapOutputW0gAmount !== undefined) data.swapOutputW0gAmount = BigInt(patch.swapOutputW0gAmount);
    if (patch.swapGasCostWei !== undefined) data.swapGasCostWei = BigInt(patch.swapGasCostWei);
    if (patch.unwrapTxHash !== undefined) data.unwrapTxHash = patch.unwrapTxHash;
    if (patch.unwrapGasCostWei !== undefined) data.unwrapGasCostWei = BigInt(patch.unwrapGasCostWei);
    if (patch.unwrappedOgAmount !== undefined) data.unwrappedOgAmount = BigInt(patch.unwrappedOgAmount);
    if (patch.sendTxHash !== undefined) data.sendTxHash = patch.sendTxHash;
    if (patch.sendGasCostWei !== undefined) data.sendGasCostWei = BigInt(patch.sendGasCostWei);
    if (patch.ogAmountSentToUser !== undefined) data.ogAmountSentToUser = BigInt(patch.ogAmountSentToUser);
    if (patch.ledgerTopUpTxHash !== undefined) data.ledgerTopUpTxHash = patch.ledgerTopUpTxHash;
    if (patch.ledgerTopUpGasCostWei !== undefined) data.ledgerTopUpGasCostWei = BigInt(patch.ledgerTopUpGasCostWei);
    await this.prisma.zeroGPurchase.update({ where: { id }, data });
  }
}
```

- [ ] **Step 2.8: Update `src/database/database.ts`**

```typescript
import type { AgentRepository } from './repositories/agent-repository';
import type { TransactionRepository } from './repositories/transaction-repository';
import type { PositionRepository } from './repositories/position-repository';
import type { AgentMemoryRepository } from './repositories/agent-memory-repository';
import type { ActivityLogRepository } from './repositories/activity-log-repository';
import type { UserRepository } from './repositories/user-repository';
import type { UserWalletRepository } from './repositories/user-wallet-repository';
import type { ZeroGPurchaseRepository } from './repositories/zero-g-purchase-repository';

export interface Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;
  readonly users: UserRepository;
  readonly userWallets: UserWalletRepository;
  readonly zeroGPurchases: ZeroGPurchaseRepository;
}
```

- [ ] **Step 2.9: Update `src/database/prisma-database/prisma-database.ts`**

Add to imports:
```typescript
import type { ZeroGPurchaseRepository } from '../repositories/zero-g-purchase-repository';
import { PrismaZeroGPurchaseRepository } from './prisma-zero-g-purchase-repository';
```

Add to class body after `userWallets`:
```typescript
readonly zeroGPurchases: ZeroGPurchaseRepository;
```

Add to constructor after `this.userWallets = ...`:
```typescript
this.zeroGPurchases = new PrismaZeroGPurchaseRepository(prisma);
```

- [ ] **Step 2.10: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2.11: Commit**

```bash
git add prisma/ src/database/
git commit -m "feat(treasury): add ZeroGPurchase model, repository, and findByWalletAddress"
```

---

## Task 3: TreasuryWallet

**Files:**
- Create: `src/treasury/treasury-wallet.ts`
- Create: `src/treasury/treasury-wallet.live.test.ts`

- [ ] **Step 3.1: Create `src/treasury/treasury-wallet.ts`**

```typescript
import { createPublicClient, createWalletClient, http, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unichain } from 'viem/chains';
import { ethers } from 'ethers';
import type { Env } from '../config/env.js';
import { TOKENS, USDCE_ON_ZEROG, ZEROG_NETWORKS } from '../constants/index.js';
import { resolveUnichainRpcUrl } from '../constants/unichain.js';

export class TreasuryWallet {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly unichainPublicClient: ReturnType<typeof createPublicClient>;
  readonly unichainWalletClient: ReturnType<typeof createWalletClient>;
  readonly zerogProvider: ethers.JsonRpcProvider;
  readonly zerogSigner: ethers.Wallet;
  private readonly zerogNetwork: { rpcUrl: string; chainId: number };

  constructor(env: Env) {
    this.account = privateKeyToAccount(env.TREASURY_WALLET_PRIVATE_KEY as `0x${string}`);
    this.zerogNetwork = ZEROG_NETWORKS[env.ZEROG_NETWORK];

    this.unichainPublicClient = createPublicClient({
      chain: unichain,
      transport: http(resolveUnichainRpcUrl(env)),
    });
    this.unichainWalletClient = createWalletClient({
      account: this.account,
      chain: unichain,
      transport: http(resolveUnichainRpcUrl(env)),
    });

    this.zerogProvider = new ethers.JsonRpcProvider(this.zerogNetwork.rpcUrl);
    this.zerogSigner = new ethers.Wallet(env.TREASURY_WALLET_PRIVATE_KEY, this.zerogProvider);
  }

  getAddress(): `0x${string}` {
    return this.account.address;
  }

  async getUnichainUsdcBalance(): Promise<bigint> {
    return this.unichainPublicClient.readContract({
      address: TOKENS.USDC.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.account.address],
    });
  }

  async getZerogUsdceBalance(): Promise<bigint> {
    const usdce = new ethers.Contract(
      USDCE_ON_ZEROG.address,
      ['function balanceOf(address) view returns (uint256)'],
      this.zerogProvider,
    );
    return usdce.balanceOf(this.account.address) as Promise<bigint>;
  }

  async getZerogNativeBalance(): Promise<bigint> {
    return this.zerogProvider.getBalance(this.account.address).then(BigInt);
  }

  async sendNativeOg(to: string, amount: bigint): Promise<{ txHash: string; gasCostWei: bigint }> {
    const tx = await this.zerogSigner.sendTransaction({ to, value: amount });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('sendNativeOg: no receipt');
    const gasCostWei = receipt.gasUsed * receipt.gasPrice;
    return { txHash: receipt.hash, gasCostWei };
  }
}
```

- [ ] **Step 3.2: Write live test `src/treasury/treasury-wallet.live.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../config/env.js';
import { TreasuryWallet } from './treasury-wallet.js';

describe('TreasuryWallet (live)', () => {
  const env = loadEnv();
  const wallet = new TreasuryWallet(env);

  it('returns treasury address', () => {
    const addr = wallet.getAddress();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.log('treasury address:', addr);
  });

  it('reads USDC balance on Unichain', async () => {
    const balance = await wallet.getUnichainUsdcBalance();
    expect(typeof balance).toBe('bigint');
    console.log('USDC balance (raw):', balance.toString());
  });

  it('reads USDC.e balance on 0G chain', async () => {
    const balance = await wallet.getZerogUsdceBalance();
    expect(typeof balance).toBe('bigint');
    console.log('USDC.e balance on 0G (raw):', balance.toString());
  });

  it('reads native 0G balance', async () => {
    const balance = await wallet.getZerogNativeBalance();
    expect(typeof balance).toBe('bigint');
    console.log('native OG balance (raw):', balance.toString());
  });
});
```

- [ ] **Step 3.3: Run live test**

```bash
npx vitest run src/treasury/treasury-wallet.live.test.ts
```

Expected: all 4 tests pass, balances logged.

- [ ] **Step 3.4: Commit**

```bash
git add src/treasury/
git commit -m "feat(treasury): add TreasuryWallet with Unichain + 0G balance/send helpers"
```

---

## Task 4: JaineSwapService

**Files:**
- Create: `src/treasury/jaine-swap-service.ts`
- Create: `src/treasury/jaine-swap-service.live.test.ts`

- [ ] **Step 4.1: Create `src/treasury/jaine-swap-service.ts`**

```typescript
import { ethers } from 'ethers';
import { USDCE_ON_ZEROG, W0G_ON_ZEROG, JAINE_SWAP_ROUTER_ADDRESS, JAINE_POOL_FEE } from '../constants/index.js';
import type { TreasuryWallet } from './treasury-wallet.js';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

const W0G_ABI = [
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)',
];

const SLIPPAGE_BPS = 100n; // 1% slippage tolerance

export interface SwapResult {
  swapTxHash: string;
  swapInputUsdceAmount: string;
  swapOutputW0gAmount: string;
  swapGasCostWei: string;
  unwrapTxHash: string;
  unwrapGasCostWei: string;
  unwrappedOgAmount: string;
}

export class JaineSwapService {
  constructor(private readonly treasuryWallet: TreasuryWallet) {}

  async swapUsdceToNativeOg(usdceAmount: bigint): Promise<SwapResult> {
    const signer = this.treasuryWallet.zerogSigner;
    const treasuryAddress = this.treasuryWallet.getAddress();

    const usdce = new ethers.Contract(USDCE_ON_ZEROG.address, ERC20_ABI, signer);
    const w0g = new ethers.Contract(W0G_ON_ZEROG.address, W0G_ABI, signer);
    const router = new ethers.Contract(JAINE_SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, signer);

    // Approve router
    const allowance: bigint = await usdce.allowance(treasuryAddress, JAINE_SWAP_ROUTER_ADDRESS);
    if (allowance < usdceAmount) {
      const approveTx = await usdce.approve(JAINE_SWAP_ROUTER_ADDRESS, usdceAmount);
      await approveTx.wait();
    }

    // Swap USDC.e → W0G
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    const amountOutMinimum = (usdceAmount * (10000n - SLIPPAGE_BPS)) / 10000n;

    const swapTx = await router.exactInputSingle({
      tokenIn: USDCE_ON_ZEROG.address,
      tokenOut: W0G_ON_ZEROG.address,
      fee: JAINE_POOL_FEE,
      recipient: treasuryAddress,
      deadline,
      amountIn: usdceAmount,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    });
    const swapReceipt = await swapTx.wait();
    if (!swapReceipt) throw new Error('JaineSwapService: swap tx no receipt');

    const swapGasCostWei = swapReceipt.gasUsed * swapReceipt.gasPrice;
    const w0gBalance: bigint = await w0g.balanceOf(treasuryAddress);

    // Unwrap W0G → native 0G
    const unwrapTx = await w0g.withdraw(w0gBalance);
    const unwrapReceipt = await unwrapTx.wait();
    if (!unwrapReceipt) throw new Error('JaineSwapService: unwrap tx no receipt');

    const unwrapGasCostWei = unwrapReceipt.gasUsed * unwrapReceipt.gasPrice;

    return {
      swapTxHash: swapReceipt.hash,
      swapInputUsdceAmount: usdceAmount.toString(),
      swapOutputW0gAmount: w0gBalance.toString(),
      swapGasCostWei: swapGasCostWei.toString(),
      unwrapTxHash: unwrapReceipt.hash,
      unwrapGasCostWei: unwrapGasCostWei.toString(),
      unwrappedOgAmount: w0gBalance.toString(),
    };
  }
}
```

- [ ] **Step 4.2: Write live test `src/treasury/jaine-swap-service.live.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { loadEnv } from '../config/env.js';
import { TreasuryWallet } from './treasury-wallet.js';
import { USDCE_ON_ZEROG, W0G_ON_ZEROG, ZEROG_NETWORKS, JAINE_USDC_0G_POOL_ADDRESS } from '../constants/index.js';

describe('JaineSwapService (live, read-only)', () => {
  const env = loadEnv();
  const wallet = new TreasuryWallet(env);

  it('can read pool token0 and token1', async () => {
    const poolAbi = [
      'function token0() view returns (address)',
      'function token1() view returns (address)',
      'function fee() view returns (uint24)',
    ];
    const pool = new ethers.Contract(JAINE_USDC_0G_POOL_ADDRESS, poolAbi, wallet.zerogProvider);
    const [token0, token1, fee] = await Promise.all([pool.token0(), pool.token1(), pool.fee()]);
    expect(token0.toLowerCase()).toBe(W0G_ON_ZEROG.address.toLowerCase());
    expect(token1.toLowerCase()).toBe(USDCE_ON_ZEROG.address.toLowerCase());
    expect(Number(fee)).toBe(10000);
    console.log('pool verified: token0=W0G token1=USDC.e fee=10000');
  });

  it('reads treasury USDC.e balance on 0G', async () => {
    const balance = await wallet.getZerogUsdceBalance();
    expect(typeof balance).toBe('bigint');
    console.log('treasury USDC.e balance:', balance.toString());
  });
});
```

- [ ] **Step 4.3: Run live test**

```bash
npx vitest run src/treasury/jaine-swap-service.live.test.ts
```

Expected: pool token0/token1/fee verified, balance logged.

- [ ] **Step 4.4: Commit**

```bash
git add src/treasury/jaine-swap-service.ts src/treasury/jaine-swap-service.live.test.ts
git commit -m "feat(treasury): add JaineSwapService (USDC.e→W0G→native 0G)"
```

---

## Task 5: AcrossBridgeService

**Files:**
- Create: `src/treasury/across-bridge-service.ts`
- Create: `src/treasury/across-bridge-service.live.test.ts`

- [ ] **Step 5.1: Install Across SDK**

```bash
npm install @across-protocol/app-sdk
```

- [ ] **Step 5.2: Verify Across supports Unichain→0G route**

Run this one-off check before implementing:

```bash
node -e "
const url = 'https://app.across.to/api/available-routes?originChainId=130&destinationChainId=16661&originToken=0x078D782b760474a361dDA0AF3839290b0EF57AD6&destinationToken=0x1f3aa82227281ca364bfb3d253b0f1af1da6473e';
fetch(url).then(r=>r.json()).then(console.log).catch(console.error)
"
```

If the route is not supported (empty array or error): consult Across docs for the correct `destinationToken` address or alternative bridge. Do not proceed to Step 5.3 until this is confirmed.

- [ ] **Step 5.3: Create `src/treasury/across-bridge-service.ts`**

```typescript
import { createAcrossClient } from '@across-protocol/app-sdk';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unichain } from 'viem/chains';
import type { TreasuryWallet } from './treasury-wallet.js';
import { TOKENS, USDCE_ON_ZEROG } from '../constants/index.js';
import { resolveUnichainRpcUrl } from '../constants/unichain.js';
import type { Env } from '../config/env.js';

export interface BridgeResult {
  bridgeTxHash: string;
  bridgeGasCostWei: string;
}

export class AcrossBridgeService {
  private readonly acrossClient: ReturnType<typeof createAcrossClient>;

  constructor(
    private readonly treasuryWallet: TreasuryWallet,
    private readonly env: Env,
  ) {
    this.acrossClient = createAcrossClient({
      integratorId: '0x0000000000000000000000000000000000dead01',
      chains: [unichain],
      useTestnet: false,
    });
  }

  async bridgeUsdcToZerogAndWait(
    amount: bigint,
    destinationChainId: number,
  ): Promise<BridgeResult> {
    const routes = await this.acrossClient.getAvailableRoutes({
      originChainId: unichain.id,
      destinationChainId,
      originToken: TOKENS.USDC.address,
      destinationToken: USDCE_ON_ZEROG.address,
    });

    if (routes.length === 0) {
      throw new Error(`AcrossBridgeService: no route Unichain→${destinationChainId} for USDC→USDC.e`);
    }

    const quote = await this.acrossClient.getQuote({
      route: routes[0],
      inputAmount: amount,
      recipient: this.treasuryWallet.getAddress(),
    });

    let bridgeTxHash = '';
    let bridgeGasCostWei = 0n;

    const { depositId } = await this.acrossClient.executeQuote({
      walletClient: this.treasuryWallet.unichainWalletClient,
      quote,
      onProgress: async (progress) => {
        if (progress.step === 'deposit' && progress.status === 'txSuccess') {
          bridgeTxHash = progress.depositTxHash ?? '';
          const receipt = await this.treasuryWallet.unichainPublicClient.getTransactionReceipt({
            hash: bridgeTxHash as `0x${string}`,
          });
          bridgeGasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
        }
      },
    });

    await this.acrossClient.waitForDepositFilled(depositId, { pollingInterval: 10_000 });

    return {
      bridgeTxHash,
      bridgeGasCostWei: bridgeGasCostWei.toString(),
    };
  }
}
```

- [ ] **Step 5.4: Write live test `src/treasury/across-bridge-service.live.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { createAcrossClient } from '@across-protocol/app-sdk';
import { unichain } from 'viem/chains';
import { TOKENS, USDCE_ON_ZEROG, ZEROG_NETWORKS } from '../constants/index.js';
import { loadEnv } from '../config/env.js';

describe('AcrossBridgeService (live, read-only)', () => {
  const env = loadEnv();

  it('Across has a route from Unichain to 0G for USDC→USDC.e', async () => {
    const client = createAcrossClient({
      integratorId: '0x0000000000000000000000000000000000dead01',
      chains: [unichain],
    });
    const destinationChainId = ZEROG_NETWORKS[env.ZEROG_NETWORK].chainId;
    const routes = await client.getAvailableRoutes({
      originChainId: unichain.id,
      destinationChainId,
      originToken: TOKENS.USDC.address,
      destinationToken: USDCE_ON_ZEROG.address,
    });
    expect(routes.length).toBeGreaterThan(0);
    console.log('available routes:', routes);
  });
});
```

- [ ] **Step 5.5: Run live test**

```bash
npx vitest run src/treasury/across-bridge-service.live.test.ts
```

Expected: route found, logged. If this fails, resolve route availability before proceeding.

- [ ] **Step 5.6: Commit**

```bash
git add src/treasury/across-bridge-service.ts src/treasury/across-bridge-service.live.test.ts package.json package-lock.json
git commit -m "feat(treasury): add AcrossBridgeService (USDC Unichain→0G bridge)"
```

---

## Task 6: TreasuryFundsWatcher

**Files:**
- Create: `src/treasury/treasury-funds-watcher.ts`

- [ ] **Step 6.1: Install viem's webSocket transport (already in viem, no extra install)**

Verify viem exports `webSocket`:

```bash
node -e "const { webSocket } = require('viem'); console.log(typeof webSocket)"
```

Expected: `function`

- [ ] **Step 6.2: Create `src/treasury/treasury-funds-watcher.ts`**

```typescript
import { createPublicClient, webSocket, parseAbi } from 'viem';
import { unichain } from 'viem/chains';
import type IORedis from 'ioredis';
import type { Env } from '../config/env.js';
import { TOKENS, TREASURY_REDIS_QUEUE } from '../constants/index.js';
import type { TreasuryWallet } from './treasury-wallet.js';

export interface TreasuryTransferEvent {
  fromAddress: string;
  toAddress: string;
  amount: string;
  txHash: string;
  blockNumber: string;
}

export class TreasuryFundsWatcher {
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly env: Env,
    private readonly treasuryWallet: TreasuryWallet,
    private readonly redis: IORedis,
  ) {}

  start(): void {
    const alchemyWsUrl = `wss://unichain-mainnet.g.alchemy.com/v2/${this.env.ALCHEMY_API_KEY}`;
    const client = createPublicClient({
      chain: unichain,
      transport: webSocket(alchemyWsUrl),
    });

    const treasuryAddress = this.treasuryWallet.getAddress().toLowerCase() as `0x${string}`;

    this.unwatch = client.watchContractEvent({
      address: TOKENS.USDC.address,
      abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
      eventName: 'Transfer',
      args: { to: treasuryAddress },
      onLogs: (logs) => {
        for (const log of logs) {
          const event: TreasuryTransferEvent = {
            fromAddress: log.args.from as string,
            toAddress: log.args.to as string,
            amount: (log.args.value as bigint).toString(),
            txHash: log.transactionHash ?? '',
            blockNumber: (log.blockNumber ?? 0n).toString(),
          };
          this.redis.lpush(TREASURY_REDIS_QUEUE, JSON.stringify(event)).catch((err) => {
            console.error('[TreasuryFundsWatcher] redis lpush error:', err);
          });
          console.log(`[TreasuryFundsWatcher] detected USDC transfer from ${event.fromAddress}, amount=${event.amount}`);
        }
      },
      onError: (err) => {
        console.error('[TreasuryFundsWatcher] watchContractEvent error:', err);
      },
    });

    console.log(`[TreasuryFundsWatcher] watching USDC transfers to ${treasuryAddress}`);
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    console.log('[TreasuryFundsWatcher] stopped');
  }
}
```

- [ ] **Step 6.3: Commit**

```bash
git add src/treasury/treasury-funds-watcher.ts
git commit -m "feat(treasury): add TreasuryFundsWatcher (Unichain WebSocket → Redis queue)"
```

---

## Task 7: PrivyZeroGSigner + TreasuryService

**Files:**
- Create: `src/wallet/privy/privy-zerog-signer.ts`
- Create: `src/treasury/treasury-service.ts`

- [ ] **Step 7.1: Create `src/wallet/privy/privy-zerog-signer.ts`**

```typescript
import { ethers } from 'ethers';
import type { PrivyClient } from '@privy-io/server-auth';

export class PrivyZeroGSigner extends ethers.AbstractSigner {
  constructor(
    private readonly privy: PrivyClient,
    private readonly walletId: string,
    private readonly walletAddress: string,
    private readonly chainId: number,
    provider: ethers.Provider,
  ) {
    super(provider);
  }

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  async signTransaction(_tx: ethers.TransactionRequest): Promise<string> {
    throw new Error('PrivyZeroGSigner: use sendTransaction instead of signTransaction');
  }

  async signMessage(_message: string | Uint8Array): Promise<string> {
    throw new Error('PrivyZeroGSigner: signMessage not supported');
  }

  async signTypedData(
    _domain: ethers.TypedDataDomain,
    _types: Record<string, ethers.TypedDataField[]>,
    _value: Record<string, unknown>,
  ): Promise<string> {
    throw new Error('PrivyZeroGSigner: signTypedData not supported');
  }

  async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
    const caip2 = `eip155:${this.chainId}`;
    const { hash } = await (this.privy.walletApi as any).ethereum.sendTransaction({
      walletId: this.walletId,
      caip2,
      transaction: {
        to: tx.to as string,
        data: tx.data ? ethers.hexlify(tx.data as ethers.BytesLike) : undefined,
        value: tx.value ? ethers.toBeHex(tx.value) : undefined,
        chainId: this.chainId,
      },
    });
    const response = await this.provider!.getTransaction(hash);
    if (!response) throw new Error(`PrivyZeroGSigner: tx ${hash} not found after send`);
    return response;
  }

  connect(provider: ethers.Provider): PrivyZeroGSigner {
    return new PrivyZeroGSigner(this.privy, this.walletId, this.walletAddress, this.chainId, provider);
  }
}
```

- [ ] **Step 7.2: Create `src/treasury/treasury-service.ts`**

```typescript
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import type IORedis from 'ioredis';
import type { PrivyClient } from '@privy-io/server-auth';
import type { Env } from '../config/env.js';
import type { Database } from '../database/database.js';
import type { ZeroGPurchase } from '../database/types.js';
import { TREASURY_REDIS_QUEUE, TREASURY_SERVICE_FEE_BPS, ZEROG_NETWORKS } from '../constants/index.js';
import { ZeroGBrokerFactory } from '../ai/zerog-broker/zerog-broker-factory.js';
import { ZeroGBrokerService } from '../ai/zerog-broker/zerog-broker-service.js';
import { ZeroGBootstrapStore } from '../ai/zerog-broker/zerog-bootstrap-store.js';
import { PrivyZeroGSigner } from '../wallet/privy/privy-zerog-signer.js';
import type { TreasuryWallet } from './treasury-wallet.js';
import type { JaineSwapService } from './jaine-swap-service.js';
import type { AcrossBridgeService } from './across-bridge-service.js';
import type { TreasuryTransferEvent } from './treasury-funds-watcher.js';

const MIN_USDCE_BALANCE_FOR_BRIDGE = 10n * 1_000_000n; // 10 USDC.e

export class TreasuryService {
  private running = false;

  constructor(
    private readonly env: Env,
    private readonly db: Database,
    private readonly redis: IORedis,
    private readonly treasuryWallet: TreasuryWallet,
    private readonly jaineSwap: JaineSwapService,
    private readonly acrossBridge: AcrossBridgeService,
    private readonly privy: PrivyClient,
  ) {}

  start(): void {
    this.running = true;
    void this.consume();
    console.log('[TreasuryService] started, consuming from', TREASURY_REDIS_QUEUE);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.redis.brpop(TREASURY_REDIS_QUEUE, 5);
        if (!result) continue;
        const event: TreasuryTransferEvent = JSON.parse(result[1]);
        await this.processTransferEvent(event);
      } catch (err) {
        console.error('[TreasuryService] consume error:', err);
      }
    }
  }

  private async processTransferEvent(event: TreasuryTransferEvent): Promise<void> {
    const userWallet = await this.db.userWallets.findByWalletAddress(event.fromAddress);
    if (!userWallet) {
      console.log(`[TreasuryService] unknown sender ${event.fromAddress}, skipping`);
      return;
    }

    const duplicate = await this.db.zeroGPurchases.findByIncomingTxHash(event.txHash);
    if (duplicate) {
      console.log(`[TreasuryService] duplicate event for tx ${event.txHash}, skipping`);
      return;
    }

    const incomingAmount = BigInt(event.amount);
    const serviceFeeAmount = (incomingAmount * BigInt(TREASURY_SERVICE_FEE_BPS)) / 10000n;
    const swapInputAmount = incomingAmount - serviceFeeAmount;

    const now = Date.now();
    const purchase: ZeroGPurchase = {
      id: randomUUID(),
      userId: userWallet.userId,
      userWalletAddress: event.fromAddress,
      incomingTxHash: event.txHash,
      incomingUsdcAmount: incomingAmount.toString(),
      serviceFeeUsdcAmount: serviceFeeAmount.toString(),
      swapInputUsdcAmount: swapInputAmount.toString(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.zeroGPurchases.insert(purchase);

    try {
      await this.runPipeline(purchase, swapInputAmount, userWallet);
    } catch (err) {
      await this.db.zeroGPurchases.update(purchase.id, {
        status: 'failed',
        errorMessage: (err as Error).message,
      });
      console.error(`[TreasuryService] pipeline failed for ${purchase.id}:`, err);
    }
  }

  private async runPipeline(
    purchase: ZeroGPurchase,
    swapInputAmount: bigint,
    userWallet: { userId: string; walletAddress: string; privyWalletId: string },
  ): Promise<void> {
    const zerogNetwork = ZEROG_NETWORKS[this.env.ZEROG_NETWORK];

    // 1. Bridge if needed
    const usdceBalance = await this.treasuryWallet.getZerogUsdceBalance();
    if (usdceBalance < swapInputAmount + MIN_USDCE_BALANCE_FOR_BRIDGE) {
      await this.db.zeroGPurchases.update(purchase.id, { status: 'bridging' });
      const bridgeResult = await this.acrossBridge.bridgeUsdcToZerogAndWait(
        swapInputAmount,
        zerogNetwork.chainId,
      );
      await this.db.zeroGPurchases.update(purchase.id, {
        bridgeTxHash: bridgeResult.bridgeTxHash,
        bridgeGasCostWei: bridgeResult.bridgeGasCostWei,
      });
    }

    // 2. Swap USDC.e → W0G → native 0G
    await this.db.zeroGPurchases.update(purchase.id, { status: 'swapping' });
    const swapResult = await this.jaineSwap.swapUsdceToNativeOg(swapInputAmount);
    await this.db.zeroGPurchases.update(purchase.id, {
      swapTxHash: swapResult.swapTxHash,
      swapInputUsdceAmount: swapResult.swapInputUsdceAmount,
      swapOutputW0gAmount: swapResult.swapOutputW0gAmount,
      swapGasCostWei: swapResult.swapGasCostWei,
      unwrapTxHash: swapResult.unwrapTxHash,
      unwrapGasCostWei: swapResult.unwrapGasCostWei,
      unwrappedOgAmount: swapResult.unwrappedOgAmount,
    });

    // 3. Send native 0G to user
    await this.db.zeroGPurchases.update(purchase.id, { status: 'sending' });
    const nativeOgAmount = BigInt(swapResult.unwrappedOgAmount);
    // Reserve ~0.01 OG for broker top-up gas
    const gasReserve = ethers.parseEther('0.01');
    const sendAmount = nativeOgAmount > gasReserve ? nativeOgAmount - gasReserve : nativeOgAmount;
    const sendResult = await this.treasuryWallet.sendNativeOg(userWallet.walletAddress, sendAmount);
    await this.db.zeroGPurchases.update(purchase.id, {
      sendTxHash: sendResult.txHash,
      sendGasCostWei: sendResult.gasCostWei.toString(),
      ogAmountSentToUser: sendAmount.toString(),
    });

    // 4. Top up user's 0G broker ledger using their Privy wallet
    await this.db.zeroGPurchases.update(purchase.id, { status: 'topping_up' });
    const provider = new ethers.JsonRpcProvider(zerogNetwork.rpcUrl);
    const userSigner = new PrivyZeroGSigner(
      this.privy,
      userWallet.privyWalletId,
      userWallet.walletAddress,
      zerogNetwork.chainId,
      provider,
    );

    const bootstrapStore = new ZeroGBootstrapStore(this.env.DB_DIR);
    const state = await bootstrapStore.load();
    if (state) {
      const broker = await ZeroGBrokerFactory.createBrokerFromSigner(userSigner, zerogNetwork.rpcUrl);
      const brokerService = new ZeroGBrokerService(broker);
      await brokerService.ensureLedgerBalance(0.5, 1.0);
      await brokerService.fundAndAcknowledge(
        state.providerAddress,
        0.3,
        state.serviceUrl,
        state.model,
      );
      await this.db.zeroGPurchases.update(purchase.id, {
        ledgerTopUpTxHash: 'completed',
        ledgerTopUpGasCostWei: '0',
      });
    }

    await this.db.zeroGPurchases.update(purchase.id, { status: 'completed' });
    console.log(`[TreasuryService] purchase ${purchase.id} completed for user ${userWallet.userId}`);
  }
}
```

- [ ] **Step 7.3: Add `createBrokerFromSigner` to `src/ai/zerog-broker/zerog-broker-factory.ts`**

Read the file first, then add the new method. The existing factory creates a broker from a private key. Add:

```typescript
static async createBrokerFromSigner(
  signer: ethers.AbstractSigner,
  rpcUrl: string,
): Promise<ZeroGBroker> {
  return createZGComputeNetworkBroker(signer as any, rpcUrl);
}
```

- [ ] **Step 7.4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7.5: Commit**

```bash
git add src/wallet/privy/privy-zerog-signer.ts src/treasury/treasury-service.ts src/ai/zerog-broker/zerog-broker-factory.ts
git commit -m "feat(treasury): add PrivyZeroGSigner and TreasuryService orchestrator"
```

---

## Task 8: API endpoint

**Files:**
- Create: `src/api-server/routes/treasury.ts`
- Modify: `src/api-server/server.ts`
- Modify: `src/server.ts`

- [ ] **Step 8.1: Create `src/api-server/routes/treasury.ts`**

```typescript
import { Router } from 'express';
import { z } from 'zod';
import { encodeFunctionData, erc20Abi, parseUnits } from 'viem';
import type { PrivyClient } from '@privy-io/server-auth';
import type { Database } from '../../database/database.js';
import { TOKENS } from '../../constants/index.js';
import type { Env } from '../../config/env.js';

interface Deps {
  db: Database;
  privy: PrivyClient;
  env: Env;
  treasuryAddress: `0x${string}`;
}

const DepositBodySchema = z.object({
  amount: z.string().min(1),
});

export function buildTreasuryRouter(deps: Deps): Router {
  const r = Router();

  r.post('/deposit', async (req, res, next) => {
    try {
      const user = req.user!;
      const body = DepositBodySchema.parse(req.body);

      const userWallet = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (!userWallet) {
        res.status(400).json({ error: 'no_wallet', message: 'Provision a wallet first via POST /users/me/wallets' });
        return;
      }

      const amountRaw = parseUnits(body.amount, TOKENS.USDC.decimals);

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [deps.treasuryAddress, amountRaw],
      });

      const { hash } = await (deps.privy.walletApi as any).ethereum.sendTransaction({
        walletId: userWallet.privyWalletId,
        caip2: 'eip155:130',
        transaction: {
          to: TOKENS.USDC.address,
          data,
          chainId: 130,
        },
      });

      res.status(201).json({
        txHash: hash,
        amount: body.amount,
        symbol: TOKENS.USDC.symbol,
        decimals: TOKENS.USDC.decimals,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
```

- [ ] **Step 8.2: Wire treasury router into `src/api-server/server.ts`**

Read the file first. In the `ApiServer` constructor deps interface, add:
```typescript
treasuryRouter: Router;
```

In the constructor body, after the last route registration, add:
```typescript
this.app.use('/users/me/treasury', deps.treasuryRouter);
```

Alternatively, if the server builds its own routers from deps, pass the treasury router in the appropriate location (after the auth middleware).

- [ ] **Step 8.3: Wire deps in `src/server.ts`**

Read `src/server.ts`. After the existing route setup, add:

```typescript
import { buildTreasuryRouter } from './api-server/routes/treasury.js';
import { privateKeyToAccount } from 'viem/accounts';
```

Before `new ApiServer(...)`, build the treasury router:

```typescript
const treasuryAccount = privateKeyToAccount(env.TREASURY_WALLET_PRIVATE_KEY as `0x${string}`);
const treasuryRouter = buildTreasuryRouter({
  db,
  privy: privyClient,
  env,
  treasuryAddress: treasuryAccount.address,
});
```

Pass `treasuryRouter` to `ApiServer`.

- [ ] **Step 8.4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8.5: Commit**

```bash
git add src/api-server/routes/treasury.ts src/api-server/server.ts src/server.ts
git commit -m "feat(treasury): add POST /users/me/treasury/deposit endpoint"
```

---

## Task 9: Worker wiring

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 9.1: Add treasury bootstrap to `src/worker.ts`**

Read `src/worker.ts`. Add imports at the top:

```typescript
import { PrivyClient } from '@privy-io/server-auth';
import { TreasuryWallet } from './treasury/treasury-wallet.js';
import { JaineSwapService } from './treasury/jaine-swap-service.js';
import { AcrossBridgeService } from './treasury/across-bridge-service.js';
import { TreasuryFundsWatcher } from './treasury/treasury-funds-watcher.js';
import { TreasuryService } from './treasury/treasury-service.js';
```

Inside `main()`, after `const db = new PrismaDatabase(prisma);`, add:

```typescript
const privyClient = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
const treasuryWallet = new TreasuryWallet(env);
const jaineSwap = new JaineSwapService(treasuryWallet);
const acrossBridge = new AcrossBridgeService(treasuryWallet, env);

const treasuryRedis = RedisClient.build(env.REDIS_URL);
const treasuryWatcher = new TreasuryFundsWatcher(env, treasuryWallet, treasuryRedis);
const treasuryService = new TreasuryService(
  env,
  db,
  RedisClient.build(env.REDIS_URL),
  treasuryWallet,
  jaineSwap,
  acrossBridge,
  privyClient,
);

treasuryWatcher.start();
treasuryService.start();
```

In the `shutdown` function, add before `process.exit(0)`:

```typescript
treasuryWatcher.stop();
await treasuryService.stop();
await treasuryRedis.quit().catch(() => {});
```

- [ ] **Step 9.2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9.3: Smoke test worker startup (requires all env vars including TREASURY_WALLET_PRIVATE_KEY)**

```bash
npm run start:worker
```

Expected logs:
```
[TreasuryFundsWatcher] watching USDC transfers to 0x...
[TreasuryService] started, consuming from treasury:events
[bootstrap] scheduler started, ticking every 10000ms
```

Ctrl+C after confirming logs appear.

- [ ] **Step 9.4: Commit**

```bash
git add src/worker.ts
git commit -m "feat(treasury): wire TreasuryFundsWatcher + TreasuryService into worker bootstrap"
```

---

## Self-Review

Spec requirement → task coverage:
- ✅ `TREASURY_WALLET_PRIVATE_KEY` env var → Task 1
- ✅ USDC.e + W0G constants (confirmed addresses) → Task 1
- ✅ `ZeroGPurchase` model with all tracked fields → Task 2
- ✅ `UserWalletRepository.findByWalletAddress` → Task 2
- ✅ `TreasuryWallet` (balance + send) → Task 3
- ✅ Jaine `exactInputSingle` + W0G `withdraw` → Task 4
- ✅ Across bridge + wait for fill → Task 5
- ✅ Bridge-only-when-balance-low gate → Task 7 (`TreasuryService.runPipeline`)
- ✅ Service fee BPS constant → Task 1 + Task 7
- ✅ `TreasuryFundsWatcher` WebSocket → Redis LPUSH → Task 6
- ✅ `TreasuryService` BRPOP → orchestrate → Task 7
- ✅ Deduplicate by `incomingTxHash` → Task 7
- ✅ Skip non-user senders → Task 7
- ✅ `PrivyZeroGSigner` for user 0G chain txs → Task 7
- ✅ Broker ledger top-up via user's Privy wallet → Task 7
- ✅ `POST /users/me/treasury/deposit` → Task 8
- ✅ Response: `{ txHash, amount, symbol, decimals }` → Task 8
- ✅ Worker bootstrap wiring → Task 9
- ✅ PRIVY_APP_ID/SECRET required in both processes → Task 1
- ✅ All gas costs stored as bigint strings → Tasks 3-7
- ✅ All status transitions (pending→bridging→swapping→sending→topping_up→completed|failed) → Task 7
