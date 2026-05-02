# ERC-20 Transfer Tool Design

**Date:** 2026-05-02

## Overview

Add a `transferERC20Token` AI tool that lets an agent send ERC-20 tokens to any address on Unichain. The tool follows the same pattern as the existing wallet and Uniswap tools: thin factory function, Zod input schema, risk gates, DB recording.

## Tool API

```
name:        transferERC20Token
description: Transfer ERC-20 tokens to any address on Unichain.
             Token must be in the agent allowlist.
             Risk gate enforces maxTradeUSD.
             Amount is a human-readable decimal (e.g. "1.5" for 1.5 USDC).
```

### Input schema

| Field          | Type   | Description |
|----------------|--------|-------------|
| `tokenAddress` | string | 0x-prefixed Unichain token address |
| `toAddress`    | string | 0x-prefixed recipient address |
| `amountHuman`  | string | Human-decimal amount, e.g. `"1.5"` |

`tokenAddress` (not symbol) keeps the API consistent with other tools. The AI resolves symbols to addresses using existing `findTokensBySymbol` / `listAllowedTokens` tools.

### Return value

```json
{
  "transactionId": "<uuid>",
  "hash": "0x...",
  "status": "success",
  "tokenAddress": "0x...",
  "toAddress": "0x...",
  "amountRaw": "1500000",
  "amountFormatted": "1.5",
  "symbol": "USDC"
}
```

## Risk Gates

Applied in order, matching the swap tool pattern:

1. **Token allowlist** — `tokenAddress` must be in `agent.allowedTokens`
2. **Catalog lookup** — token must exist in DB catalog (provides decimals + coingeckoId)
3. **coingeckoId present** — required for USD risk math
4. **maxTradeUSD** — transfer value in USD must not exceed `agent.riskLimits.maxTradeUSD`

## Execution

1. Parse `amountHuman` → `amountRaw` via `parseUnits(amountHuman, token.decimals)`
2. Encode calldata: `encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [toAddress, amountRaw] })`
3. Call `wallet.signAndSendTransaction({ to: tokenAddress, data })`
4. Insert one `Transaction` row: `tokenIn = { tokenAddress, amount: amountRaw }`, `tokenOut = null`

No approval step needed — `transfer` operates directly on the caller's balance.

No position tracking — transfers are not swaps and do not open/close positions.

## DB Recording

One `Transaction` row per transfer:

- `tokenIn`: `{ tokenAddress, amount: amountRaw }`
- `tokenOut`: `null`
- `gasUsed`, `gasPriceWei`, `gasCostWei`: from receipt (real) or estimated (dry-run)
- `blockNumber`: from receipt (`null` for dry-run)
- `status`: `'success'` or `'failed'`

## File Layout

```
src/ai-tools/wallet/
  wallet-balance-tools.ts   (existing)
  erc20-transfer-tool.ts    (new)
```

- `buildERC20TransferTool(db, coingecko, env)` → `AgentTool`
- Registered in `tool-registry.ts` alongside other wallet tools
- Entry added to `tool-catalog.ts`

## Out of Scope

- Native ETH transfers
- Batch transfers
- Per-token transfer limits (only maxTradeUSD applies)
- Position tracking
