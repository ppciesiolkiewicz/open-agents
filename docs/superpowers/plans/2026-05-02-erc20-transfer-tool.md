# ERC-20 Transfer Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `transferERC20Token` AI tool that lets an agent send ERC-20 tokens to any address on Unichain, with the same risk gates as the swap tool and DB recording.

**Architecture:** Thin factory function `buildERC20TransferTool` in `src/ai-tools/wallet/erc20-transfer-tool.ts`. Applies four risk gates (allowlist → catalog → coingeckoId → maxTradeUSD), encodes ERC-20 `transfer` calldata via viem, calls `wallet.signAndSendTransaction`, inserts one `Transaction` row, and returns a JSON result. No new service class; no position tracking.

**Tech Stack:** TypeScript, viem (`encodeFunctionData`, `erc20Abi`, `parseUnits`, `formatUnits`), Zod, Prisma/Postgres via `Database` facade, `CoingeckoService`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/ai-tools/wallet/erc20-transfer-tool.ts` | Tool factory + all logic |
| Modify | `src/ai-tools/tool-catalog.ts` | Add catalog entry for `transferERC20Token` |
| Modify | `src/ai-tools/tool-registry.ts` | Import + register the new tool |

---

### Task 1: Create `erc20-transfer-tool.ts` with risk gates and execution

**Files:**
- Create: `src/ai-tools/wallet/erc20-transfer-tool.ts`

- [ ] **Step 1: Write the file**

```typescript
import { z } from 'zod';
import { encodeFunctionData, erc20Abi, parseUnits, formatUnits } from 'viem';
import { randomUUID } from 'node:crypto';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { UNICHAIN } from '../../constants';

const inputSchema = z.object({
  tokenAddress: z
    .string()
    .describe('0x-prefixed Unichain ERC-20 token address. Must be in the agent allowlist.'),
  toAddress: z
    .string()
    .describe('0x-prefixed recipient wallet address on Unichain.'),
  amountHuman: z
    .string()
    .describe('Human-readable decimal amount to transfer, e.g. "1.5" for 1.5 USDC.'),
});

export function buildERC20TransferTool(
  db: Database,
  coingecko: CoingeckoService,
): AgentTool<typeof inputSchema> {
  return {
    name: 'transferERC20Token',
    description:
      'Transfer ERC-20 tokens to any address on Unichain. Token must be in the agent allowlist. Risk gate enforces maxTradeUSD. Amount is a human-readable decimal (e.g. "1.5" for 1.5 USDC). Returns JSON {transactionId, hash, status, tokenAddress, toAddress, amountRaw, amountFormatted, symbol}.',
    inputSchema,
    async invoke({ tokenAddress, toAddress, amountHuman }, ctx) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
        throw new Error(`tokenAddress must be a 0x-prefixed 40-char hex address; got ${tokenAddress}`);
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
        throw new Error(`toAddress must be a 0x-prefixed 40-char hex address; got ${toAddress}`);
      }

      const tokenAddr = tokenAddress.toLowerCase();
      const allowSet = new Set(ctx.agent.allowedTokens.map((a) => a.toLowerCase()));
      if (!allowSet.has(tokenAddr)) {
        throw new Error(`token not in agent allowlist: ${tokenAddress}`);
      }

      const token = await db.tokens.findByAddress(tokenAddr, UNICHAIN.chainId);
      if (!token) throw new Error(`token not in catalog: ${tokenAddress}`);
      if (!token.coingeckoId) {
        throw new Error(`token missing coingeckoId for USD risk math: ${tokenAddress}`);
      }

      const amountRaw = parseUnits(amountHuman, token.decimals);
      const priceUSD = await coingecko.fetchTokenPriceUSD(token.coingeckoId);
      const transferUSD = (Number(amountRaw) / 10 ** token.decimals) * priceUSD;
      const maxTradeUSD = ctx.agent.riskLimits.maxTradeUSD;
      if (transferUSD > maxTradeUSD) {
        throw new Error(
          `transfer ${transferUSD.toFixed(2)} USD exceeds agent maxTradeUSD ${maxTradeUSD}`,
        );
      }

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [toAddress as `0x${string}`, amountRaw],
      });

      const receipt = await ctx.wallet.signAndSendTransaction({
        to: tokenAddress as `0x${string}`,
        data,
      });

      const gasUsed = receipt.gasUsed;
      const gasPriceWei = receipt.effectiveGasPrice;
      const tx = {
        id: `tx-${randomUUID()}`,
        agentId: ctx.agent.id,
        hash: receipt.transactionHash,
        chainId: UNICHAIN.chainId,
        fromAddress: (receipt.from ?? ctx.wallet.getAddress()) as string,
        toAddress: tokenAddress,
        tokenIn: {
          tokenAddress: tokenAddr,
          symbol: token.symbol,
          amountRaw: amountRaw.toString(),
          decimals: token.decimals,
        },
        gasUsed: gasUsed.toString(),
        gasPriceWei: gasPriceWei.toString(),
        gasCostWei: (gasUsed * gasPriceWei).toString(),
        status: receipt.status === 'success' ? ('success' as const) : ('failed' as const),
        blockNumber: receipt.blockNumber === 0n ? null : Number(receipt.blockNumber),
        timestamp: Date.now(),
      };
      await db.transactions.insert(tx);

      return {
        transactionId: tx.id,
        hash: tx.hash,
        status: tx.status,
        tokenAddress: tokenAddr,
        toAddress,
        amountRaw: amountRaw.toString(),
        amountFormatted: formatUnits(amountRaw, token.decimals),
        symbol: token.symbol,
      };
    },
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors referencing `erc20-transfer-tool.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/wallet/erc20-transfer-tool.ts
git commit -m "feat(ai-tools): add transferERC20Token tool"
```

---

### Task 2: Register in catalog and tool registry

**Files:**
- Modify: `src/ai-tools/tool-catalog.ts`
- Modify: `src/ai-tools/tool-registry.ts`

- [ ] **Step 1: Add catalog entry to `tool-catalog.ts`**

In `src/ai-tools/tool-catalog.ts`, append one entry to the `TOOL_CATALOG` array after the `wallet.balance.token.get` entry (line 18):

```typescript
  { id: 'wallet.transfer.erc20', name: 'Transfer ERC-20 token', callableName: 'transferERC20Token', description: 'Transfer ERC-20 tokens to any address on Unichain', category: 'wallet' },
```

The array after the three wallet entries should look like:

```typescript
  { id: 'wallet.address.get', name: 'Get wallet address', callableName: 'getWalletAddress', description: 'Get current agent wallet address', category: 'wallet' },
  { id: 'wallet.balance.native.get', name: 'Get native balance', callableName: 'getNativeBalance', description: 'Get native token balance for current wallet', category: 'wallet' },
  { id: 'wallet.balance.token.get', name: 'Get token balance', callableName: 'getTokenBalance', description: 'Get ERC-20 token balance for current wallet', category: 'wallet' },
  { id: 'wallet.transfer.erc20', name: 'Transfer ERC-20 token', callableName: 'transferERC20Token', description: 'Transfer ERC-20 tokens to any address on Unichain', category: 'wallet' },
```

- [ ] **Step 2: Import and register in `tool-registry.ts`**

Add the import after the existing wallet import on line 14:

```typescript
import { buildERC20TransferTool } from './wallet/erc20-transfer-tool';
```

In `ToolRegistry.build()`, add the tool after `tokenBalance` (after line 56):

```typescript
      buildERC20TransferTool(this.deps.db, this.deps.coingecko),
```

The wallet section of the `tools` array should now read:

```typescript
      walletAddress,
      nativeBalance,
      tokenBalance,
      buildERC20TransferTool(this.deps.db, this.deps.coingecko),
```

- [ ] **Step 3: Verify TypeScript compiles and catalog assertion passes**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run existing tool-registry test to confirm catalog assertion**

```bash
npx vitest run src/ai-tools/tool-registry.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ai-tools/tool-catalog.ts src/ai-tools/tool-registry.ts
git commit -m "feat(ai-tools): register transferERC20Token in catalog and registry"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|-----------------|------|
| Tool name `transferERC20Token` | Task 1 |
| Inputs: tokenAddress, toAddress, amountHuman | Task 1 |
| Risk gate 1: allowlist | Task 1 |
| Risk gate 2: catalog lookup | Task 1 |
| Risk gate 3: coingeckoId present | Task 1 |
| Risk gate 4: maxTradeUSD | Task 1 |
| ERC-20 `transfer` calldata via viem | Task 1 |
| wallet.signAndSendTransaction | Task 1 |
| Transaction inserted (tokenIn only, no tokenOut) | Task 1 |
| No position tracking | Task 1 (absent by design) |
| Return value shape | Task 1 |
| tool-catalog.ts entry | Task 2 |
| tool-registry.ts registration | Task 2 |

All spec requirements covered. No gaps.

**Placeholder scan:** None found.

**Type consistency:**
- `TokenAmount` shape: `{ tokenAddress, symbol, amountRaw, decimals }` — matches `src/database/types.ts:1-6`
- `Transaction` shape: all required fields present — matches `src/database/types.ts:40-55`
- `AgentTool<typeof inputSchema>` — matches `src/ai-tools/tool.ts`
- `buildERC20TransferTool(db, coingecko)` signature used consistently in Task 1 and Task 2
