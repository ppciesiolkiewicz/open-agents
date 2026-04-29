# Treasury Service Design

Date: 2026-04-29

## Overview

When a user sends USDC to the treasury wallet on Unichain, the system automatically:
1. Detects the transfer via WebSocket event subscription
2. Bridges USDC to 0G chain via Across protocol if USDC.e balance on 0G is low
3. Swaps USDC.e → W0G on the Jaine pool (Uniswap V3-style `exactInputSingle`)
4. Unwraps W0G → native 0G via standard WETH9 `withdraw`
5. Sends native 0G to the user's address on 0G chain (same address as Unichain sender)
6. Using the user's Privy wallet on 0G chain: tops up their broker ledger and acknowledges the provider/model

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
5. Swap USDC.e → W0G on Jaine pool via `exactInputSingle` (status: `swapping`), record swap tx hash + amounts + gas
6. Unwrap W0G → native 0G via `W0G.withdraw(amount)`, record unwrap tx hash + gas
7. Send native 0G to user's address on 0G chain (status: `sending`), record send tx hash + gas
8. Using user's Privy wallet on 0G chain: create/top up broker ledger, acknowledge provider + model (status: `topping_up`), record ledger top-up tx hash + gas
9. Mark `completed` or `failed` with error message

### API endpoint in server process

**`POST /users/me/treasury/deposit`**
- Auth: existing Privy middleware
- Body: `{ amount: string }` (human-readable USDC, e.g. `"10.5"`)
- Looks up user's `UserWallet` (Privy wallet address)
- Executes USDC `transfer(treasuryAddress, parsedAmount)` from user's Privy wallet
- Response: `{ txHash, amount, symbol, decimals }` — symbol and decimals from USDC constants
- Only USDC supported

The transfer triggers a Unichain USDC `Transfer` event → `TreasuryFundsWatcher` picks it up → `TreasuryService` processes it automatically.

## Module Structure

```
src/
  treasury/
    treasury-service.ts          # consumes treasury:events queue, orchestrates pipeline
    treasury-funds-watcher.ts    # viem WebSocket watchContractEvent → pushes to Redis queue
    jaine-swap-service.ts        # approve + swap USDCe→W0G + unwrap W0G→native 0G (ethers.js)
    across-bridge-service.ts     # bridge USDC Unichain→0G via Across protocol, waits for fill
    treasury-wallet.ts           # treasury keypair, balance checks, native send on both chains
  database/
    repositories/                # + ZeroGPurchaseRepository interface
    prisma-database/             # + PrismaZeroGPurchaseRepository impl
    types.ts                     # + ZeroGPurchase domain type + status enum
  constants/
    treasury.ts                  # fee BPS, Jaine addresses, queue name, token addresses
```

Wired into `worker.ts` (watcher + service) and `server.ts` (deposit endpoint).

## Resolved Contract Addresses (0G mainnet, chainId 16661)

| Contract | Address | Notes |
|---|---|---|
| USDC.e | `0x1f3aa82227281ca364bfb3d253b0f1af1da6473e` | 6 decimals, bridged via Across |
| W0G | `0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c` | 18 decimals, standard WETH9 interface |
| Jaine SwapRouter | `0x8b598a7c136215a95ba0282b4d832b9f9801f2e2` | Uniswap V3 `exactInputSingle` |
| Jaine Factory | `0x9bdca5798e52e592a08e3b34d3f18eef76af7ef4` | |
| Jaine USDC.e/W0G pool | `0x961DA9B2FD03e04b088A90843a93E66f13112D0a` | fee=10000 (1%), token0=W0G, token1=USDC.e |

## Data Model

### `ZeroGPurchase`

```ts
type ZeroGPurchaseStatus =
  | 'pending'
  | 'bridging'
  | 'swapping'
  | 'sending'
  | 'topping_up'
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

  // Jaine pool swap (USDC.e → W0G)
  swapTxHash?: string;
  swapInputUsdceAmount?: string;    // USDC.e supplied to Jaine pool
  swapOutputW0gAmount?: string;     // W0G received from pool
  swapGasCostWei?: string;

  // W0G unwrap → native 0G
  unwrapTxHash?: string;
  unwrapGasCostWei?: string;
  unwrappedOgAmount?: string;       // native 0G received after unwrap

  // Send native 0G to user
  sendTxHash?: string;
  sendGasCostWei?: string;
  ogAmountSentToUser?: string;      // net 0G after gas deductions

  // Broker ledger top-up (from user's Privy wallet on 0G chain)
  ledgerTopUpTxHash?: string;
  ledgerTopUpGasCostWei?: string;

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
export const TREASURY_SERVICE_FEE_BPS = 1000;   // 10% fee retained by treasury
export const JAINE_USDC_0G_POOL_ADDRESS = "0x961DA9B2FD03e04b088A90843a93E66f13112D0a";
export const JAINE_SWAP_ROUTER_ADDRESS = "0x8b598a7c136215a95ba0282b4d832b9f9801f2e2";
export const TREASURY_REDIS_QUEUE = "treasury:events";

// src/constants/tokens.ts additions
export const USDCE_ON_ZEROG = {
  symbol: "USDC.e",
  decimals: 6,
  address: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e",
};
export const W0G = {
  symbol: "W0G",
  decimals: 18,
  address: "0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c",
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
`TreasuryFundsWatcher` uses viem `webSocket` transport with Alchemy WebSocket URL
(`wss://unichain-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY>`). Separate from the HTTP transport used by the existing public client.

### 0G chain interaction
`JaineSwapService` and `AcrossBridgeService` use ethers.js (consistent with existing 0G code in `src/ai/zerog-broker/`), not viem. Treasury wallet on 0G chain is an ethers.js `Wallet` derived from `TREASURY_WALLET_PRIVATE_KEY` connected to the 0G mainnet RPC.

### Jaine swap
`JaineSwapService.swapUsdceToNativeOg(amount)`:
1. Approve Jaine SwapRouter to spend USDC.e
2. Call `SwapRouter.exactInputSingle({ tokenIn: USDC.e, tokenOut: W0G, fee: 10000, recipient: treasuryAddress, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0 })`
3. Call `W0G.withdraw(w0gAmount)` — treasury wallet receives native 0G

### Broker ledger top-up
After sending native 0G to the user, `TreasuryService` uses the user's Privy wallet via Privy's server-side signing API to sign transactions on 0G chain (chainId 16661). Calls `ZeroGBrokerService` operations scoped to the user's wallet: `createLedger` (if not exists), `ensureLedgerBalance`, `fundAndAcknowledge` (provider + model from bootstrap store). Privy server wallet signing works cross-chain — same key pair, different chainId.

### Fee calculation
```ts
const serviceFeeAmount = (incomingAmount * BigInt(TREASURY_SERVICE_FEE_BPS)) / 10000n;
const swapInputAmount = incomingAmount - serviceFeeAmount;
```

### Bridge wait
`AcrossBridgeService.bridgeAndWait()` uses the Across SDK or REST API to submit a deposit and poll for fill confirmation. Returns once the USDC.e appears on 0G chain.

### Error handling
Any step failure sets `ZeroGPurchase.status = 'failed'` with `errorMessage`. No retries in v1 — failed purchases visible in DB for manual review.

### Non-user senders
If `UserWallet` lookup by `fromAddress` returns null, event is logged and skipped. USDC remains in treasury wallet (manual handling out of scope for v1).

## Env Changes

```
TREASURY_WALLET_PRIVATE_KEY=   # separate from WALLET_PRIVATE_KEY; used on both Unichain and 0G chain
```

`.env.example` updated in same commit.

## Worker Bootstrap Changes

`worker.ts` additions:
```ts
const treasuryFundsWatcher = new TreasuryFundsWatcher({ env, redisClient });
const treasuryService = new TreasuryService({ env, db, redisClient, privyClient });

await treasuryFundsWatcher.start();
await treasuryService.start();

// shutdown
await treasuryFundsWatcher.stop();
await treasuryService.stop();
```

Note: `privyClient` passed to `TreasuryService` for signing user-wallet 0G chain transactions. Worker process must have `PRIVY_APP_ID` + `PRIVY_APP_SECRET` in env (currently server-only — env schema update needed).

## Out of Scope (v1)

- Retry logic for failed purchases
- Multiple token support (USDC only)
- Per-user purchase limits / rate limiting
- Manual USDC treasury top-up automation
