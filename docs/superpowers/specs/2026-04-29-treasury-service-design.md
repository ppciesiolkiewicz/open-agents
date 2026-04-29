# Treasury Service Design

Date: 2026-04-29

## Overview

When a user sends USDC to the treasury wallet on Unichain, the system automatically:
1. Detects the transfer via WebSocket event subscription
2. Bridges USDC to 0G chain via Across protocol if USDC.e balance on 0G is low
3. Swaps USDC.e → 0G on the Jaine pool
4. Sends 0G to the user's address on 0G chain (same address as Unichain sender)

A service fee (defined as a BPS constant) is retained by the treasury before swapping.

## Architecture

### Two new components in the worker process

**`TreasuryFundsWatcher`**
Opens a viem WebSocket client to Alchemy (Unichain). Calls `watchContractEvent` on the USDC contract, filtering `Transfer` events where `to = treasury address`. On each matching event, pushes a serialized `TreasuryTransferEvent` onto the `treasury:events` Redis queue (LPUSH). Runs alongside the existing `IntervalScheduler` and `TickDispatcher`.

**`TreasuryService`**
Consumes from `treasury:events` (BRPOP). For each event:
1. Look up `UserWallet` by sender address — skip if not found (non-user sender)
2. Create `ZeroGPurchase` row (status: `pending`)
3. Check USDC.e balance on 0G chain
4. If balance too low → bridge via Across (status: `bridging`), wait for completion, record bridge tx hash + gas
5. Swap USDC.e → 0G on Jaine pool (status: `swapping`), record swap tx hash, amounts, gas
6. Send 0G to user on 0G chain (status: `sending`), record send tx hash + gas
7. Mark `completed` or `failed` with error message

### API endpoint in server process

**`POST /users/me/treasury/deposit`**
- Auth: existing Privy middleware
- Body: `{ amount: string }` (human-readable USDC, e.g. `"10.5"`)
- Looks up user's `UserWallet` (Privy wallet address)
- Executes USDC `transfer(treasuryAddress, parsedAmount)` from user's Privy wallet
- Response: `{ txHash, amount, symbol, decimals }`
- Only USDC supported

The transfer triggers a Unichain USDC `Transfer` event → `TreasuryFundsWatcher` picks it up → `TreasuryService` processes it automatically.

## Module Structure

```
src/
  treasury/
    treasury-service.ts          # consumes treasury:events queue, orchestrates pipeline
    treasury-funds-watcher.ts    # viem WebSocket watchContractEvent → pushes to Redis queue
    jaine-swap-service.ts        # swap USDCe→0G on Jaine pool (0G chain, ethers.js)
    across-bridge-service.ts     # bridge USDC Unichain→0G via Across protocol, waits for completion
    treasury-wallet.ts           # treasury address, send/balance helpers for both chains
  database/
    repositories/                # + ZeroGPurchaseRepository interface
    prisma-database/             # + PrismaZeroGPurchaseRepository impl
    types.ts                     # + ZeroGPurchase domain type + status enum
  constants/
    treasury.ts                  # fee BPS, Jaine pool address, queue name, USDC.e on 0G
```

## Data Model

### `ZeroGPurchase`

```ts
type ZeroGPurchaseStatus =
  | 'pending'
  | 'bridging'
  | 'swapping'
  | 'sending'
  | 'completed'
  | 'failed';

interface ZeroGPurchase {
  id: string;                       // uuid PK
  userId: string;                   // FK → User
  userWalletAddress: string;        // sender on Unichain = recipient on 0G

  // Incoming transfer
  incomingTxHash: string;           // Unichain USDC Transfer tx hash
  incomingUsdcAmount: string;       // full received amount (bigint as string)

  // Fee + swap inputs
  serviceFeeUsdcAmount: string;     // kept by treasury
  swapInputUsdcAmount: string;      // incomingUsdcAmount minus fee

  // Bridge (populated only when 0G USDC.e balance was insufficient)
  bridgeTxHash?: string;
  bridgeGasCostWei?: string;

  // Jaine pool swap
  swapTxHash?: string;
  swapInputUsdceAmount?: string;    // USDC.e supplied to pool
  swapOutputOgAmount?: string;      // 0G retrieved from pool
  swapGasCostWei?: string;

  // Send 0G to user
  sendTxHash?: string;
  sendGasCostWei?: string;

  status: ZeroGPurchaseStatus;
  errorMessage?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

All bigint amounts stored as strings in JSON and DB (project-wide convention).

## Constants

```ts
// src/constants/treasury.ts
export const TREASURY_SERVICE_FEE_BPS = 1000;          // 10% fee retained by treasury
export const JAINE_USDC_0G_POOL_ADDRESS = "0x961DA9B2FD03e04b088A90843a93E66f13112D0a";
export const TREASURY_REDIS_QUEUE = "treasury:events";

// Added to src/constants/tokens.ts
// USDC.e address on 0G chain must be confirmed from Across bridge docs / Jaine pool contract
// before implementation. Decimals: 6 (same as USDC).
export const USDCE_ON_ZEROG = {
  symbol: "USDC.e",
  decimals: 6,
  address: "TBD — resolve from Across bridge output token on 0G chain",
};
```

## Event Schema

```ts
interface TreasuryTransferEvent {
  fromAddress: string;       // sender on Unichain (= user's 0G address)
  toAddress: string;         // treasury wallet address
  amount: string;            // raw USDC amount (bigint as string)
  txHash: string;            // Unichain tx hash
  blockNumber: string;       // bigint as string
}
```

## Key Implementation Notes

### Event listening
`TreasuryFundsWatcher` uses viem `webSocket` transport with Alchemy WebSocket URL (`wss://unichain-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY>`). Separate from the HTTP transport used by the existing public client.

### 0G chain interaction
`JaineSwapService` and `AcrossBridgeService` use ethers.js (consistent with existing 0G code in `src/ai/zerog-broker/`), not viem. Treasury wallet on 0G chain derived from `TREASURY_WALLET_PRIVATE_KEY`.

### Fee calculation
```ts
const feeBps = TREASURY_SERVICE_FEE_BPS;
const serviceFeeAmount = (incomingAmount * BigInt(feeBps)) / 10000n;
const swapInputAmount = incomingAmount - serviceFeeAmount;
```

### Bridge wait
`AcrossBridgeService.bridgeAndWait()` polls the Across status API (`https://app.across.to/api/...`) for fill status until confirmed, then returns. Exact endpoint resolved during implementation from Across SDK / docs. `TreasuryService` awaits this before proceeding to swap.

### Jaine pool interface
Jaine pool contract ABI (Uniswap v2 fork or custom) must be confirmed by inspecting `0x961DA9B2FD03e04b088A90843a93E66f13112D0a` on 0G chain explorer during implementation.

### Treasury wallet role
`TreasuryWallet` owns the keypair and exposes balance checks + native send for both chains. `JaineSwapService` and `AcrossBridgeService` receive it as a signer — they do not manage keys directly.

### Error handling
Any step failure sets `ZeroGPurchase.status = 'failed'` with `errorMessage`. No retries in v1 — failed purchases are visible in DB for manual review.

### Non-user senders
If `UserWallet` lookup by `fromAddress` returns null, the event is logged and skipped. The USDC remains in the treasury wallet (manual handling out of scope for v1).

## Env Changes

```
TREASURY_WALLET_PRIVATE_KEY=   # separate from WALLET_PRIVATE_KEY; funds treasury on both Unichain and 0G
```

`.env.example` updated in same commit.

## Worker Bootstrap Changes

`worker.ts` additions:
```ts
const treasuryFundsWatcher = new TreasuryFundsWatcher({ env, redisClient });
const treasuryService = new TreasuryService({ env, db, redisClient });

await treasuryFundsWatcher.start();
await treasuryService.start();

// shutdown
await treasuryFundsWatcher.stop();
await treasuryService.stop();
```

## Out of Scope (v1)

- Retry logic for failed purchases
- Multiple token support (USDC only)
- Per-user purchase limits / rate limiting
- Manual USDC treasury top-up automation
