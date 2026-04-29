# sendTransaction Tool Design

Date: 2026-04-29

## Overview

Add a generic `sendTransaction` AI tool that lets the agent submit any EVM transaction on Unichain through its `Wallet`. The tool is the lowest-level escape hatch on the tool surface: arbitrary `to`, `value`, and `data`. It shares the same `Transaction` row + activity log treatment as the swap path so every send is auditable.

No risk gate. No allowlist. Trusted-agent design — operator constrains behavior via the agent prompt and dry-run mode, not in-tool checks.

## Motivation

Today the agent can only move funds via `executeUniswapSwapExactIn`. That excludes ERC-20 transfers, contract calls (approvals, staking, claiming), and native ETH sends. A single generic tool covers every case the wallet already supports without spawning a tool per intent.

## Architecture

### New tool: `sendTransaction`

**Location:** `src/ai-tools/wallet/send-transaction-tool.ts`

**Builder signature:**
```ts
buildSendTransactionTool(db: Database): AgentTool<typeof inputSchema>
```

**Input schema (zod):**
- `to: string` — required. 0x-prefixed 40-char hex address.
- `value?: string` — optional. Wei as bigint string. Defaults to `"0"`.
- `data?: string` — optional. 0x-prefixed hex calldata. Defaults to `"0x"`.

Validation:
- `to` matches `/^0x[0-9a-fA-F]{40}$/`
- `value` parses via `BigInt(value)`; reject negative
- `data` matches `/^0x([0-9a-fA-F]{2})*$/`

**Behavior:**
1. Build `TxRequest = { to, value: BigInt(value ?? '0'), data: data ?? '0x' }`.
2. Call `ctx.wallet.signAndSendTransaction(req)` — works transparently for `RealWallet` and `DryRunWallet` via the existing `Wallet` interface.
3. Convert receipt → `Transaction` row using the same field mapping the swap path uses (`receiptToTransaction` pattern in `UniswapService`):
   - `id: 'tx-' + randomUUID()`
   - `agentId: ctx.agent.id`
   - `chainId: UNICHAIN.chainId`
   - `fromAddress: ctx.wallet.getAddress()`
   - `toAddress: to`
   - `tokenIn: undefined`, `tokenOut: undefined`
   - `gasUsed: receipt.gasUsed.toString()`
   - `gasPriceWei: receipt.effectiveGasPrice.toString()`
   - `gasCostWei: (gasUsed * effectiveGasPrice).toString()`
   - `hash: receipt.transactionHash`
   - `status: receipt.status === 'success' ? 'success' : 'failed'`
   - `blockNumber: receipt.blockNumber === 0n ? null : Number(receipt.blockNumber)`
   - `timestamp: Date.now()`
4. Persist via `db.transactions.insert(tx)`.
5. Return JSON:
   ```ts
   {
     transactionId: tx.id,
     hash: tx.hash,
     status: tx.status,
     blockNumber: tx.blockNumber,
     gasCostWei: tx.gasCostWei,
     to,
     value, // echoed back as string
   }
   ```

**No activity-log calls inside the tool.** `AgentRunner` already wraps `toolCall` / `toolResult` events around every invocation, and the `Transaction` row is the durable record of the send.

### Wiring

`src/ai-tools/tool-registry.ts`:
- Import `buildSendTransactionTool`.
- Add to the `build()` array: `buildSendTransactionTool(this.deps.db)`.
- No new dependency on `ToolRegistryDeps` — `db` is already there.

### Dry-run

Transparent. `DryRunWallet.signAndSendTransaction` already mints a sentinel hash and synthesizes a receipt with estimated gas. The `Transaction` row gets inserted exactly the way the dry-run swap path inserts one. Operators wipe the DB between dry-run and real-run sessions per project convention; the sentinel-hash pattern makes mode obvious to a human inspecting the table.

### Risk

None. The agent prompt is the only guardrail; `agent.dryRun` is the kill switch. This matches the operator-trusts-agent posture for v1.

## Files

**New**
- `src/ai-tools/wallet/send-transaction-tool.ts`
- `src/ai-tools/wallet/send-transaction-tool.live.test.ts`

**Modified**
- `src/ai-tools/tool-registry.ts` — register the new tool.

No schema changes. No env changes. No `.env.example` update.

## Testing

`send-transaction-tool.live.test.ts`:
- Build the tool with a real `Database` (Postgres test DB) and a `DryRunWallet` (no gas spend).
- Invoke with a no-op self-send (`to = wallet.getAddress()`, `value = "0"`).
- Assert: `status === 'success'`, hash present, `Transaction` row exists for `agentId` with matching hash, `tokenIn`/`tokenOut` null, `toAddress` matches input.
- `console.log` the returned payload + the row for human inspection.

Real-wallet path (costs gas) is **not** in tests — if needed it lives under `scripts/` with `confirmContinue` guard, per CLAUDE.md policy.

## Out of scope

- Per-agent tool allowlist / per-tool config. Discussed and deferred — agent still gets every tool in `ToolRegistry.build()`.
- Risk limits on arbitrary sends (`maxSendValueUSD`, recipient allowlist). Re-add when an incident or product requirement justifies it.
- Helper tools wrapping common patterns (`erc20Transfer`, `erc20Approve`). The agent can encode calldata itself; add convenience wrappers only if the LLM proves bad at it.
