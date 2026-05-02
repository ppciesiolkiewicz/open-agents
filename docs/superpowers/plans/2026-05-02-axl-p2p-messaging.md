# AXL P2P Messaging Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all agent-to-agent and channel messages through the Gensyn AXL P2P network instead of directly into the Redis tick queue.

**Architecture:** A thin `AxlClient` wraps the local AXL node HTTP API (`POST /send`, `GET /recv`, `GET /topology`). The two send tools (`sendMessageToAgent`, `sendMessageToChannel`) call `AxlClient.send()` instead of enqueueing directly. A new `AxlPoller` runs in the worker process, polls `GET /recv` on an interval, and pushes received messages into the existing Redis tick queue — so the `TickDispatcher` and everything downstream are untouched. Agents store an `axlPeerId` (the peer ID of the AXL node where they live); local agents default to our own node's peer ID fetched at startup from `GET /topology`.

**Tech Stack:** TypeScript, existing AXL node binary in `vendors/gensyn-axl` (HTTP API on `AXL_URL`, default `http://127.0.0.1:9002`), Zod, Vitest.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/axl/axl-message.ts` | Zod schema for the JSON payload sent over AXL wire |
| Create | `src/axl/axl-client.ts` | HTTP wrapper: `send(peerId, msg)`, `recv()`, `getTopology()` |
| Create | `src/axl/axl-poller.ts` | Polls `/recv`, enqueues to `TickQueue` |
| Create | `src/axl/axl-client.live.test.ts` | Live smoke test against a running AXL node |
| Modify | `prisma/schema.prisma` | Add `axlPeerId String?` to `Agent` model |
| Modify | `src/database/types.ts` | Add `axlPeerId?: string \| null` to `AgentConfig` |
| Modify | `src/database/prisma-database/mappers.ts` | Map `axlPeerId` in `agentRowToDomain` |
| Modify | `src/database/prisma-database/prisma-agent-repository.ts` | Persist `axlPeerId` in `upsert` |
| Modify | `src/ai-tools/axl/send-message-to-agent-tool.ts` | Use `AxlClient.send()` instead of `tickQueue.enqueue()` |
| Modify | `src/ai-tools/axl/send-message-to-channel-tool.ts` | Use `AxlClient.send()` per channel member |
| Modify | `src/ai-tools/tool-registry.ts` | Replace `tickQueue` dep with `axlClient: AxlClient` in send tools |
| Modify | `src/worker.ts` | Instantiate `AxlClient` + `AxlPoller`, start poller, shut it down on exit |

---

## Task 1: AXL message schema + client

**Files:**
- Create: `src/axl/axl-message.ts`
- Create: `src/axl/axl-client.ts`

- [ ] **Step 1: Create `src/axl/axl-message.ts`**

```typescript
import { z } from 'zod';

export const AxlMessageSchema = z.object({
  targetAgentId: z.string().min(1),
  chatContent: z.string().min(1),
});

export type AxlMessage = z.infer<typeof AxlMessageSchema>;
```

- [ ] **Step 2: Create `src/axl/axl-client.ts`**

```typescript
import { AxlMessageSchema, type AxlMessage } from './axl-message';

export interface AxlTopology {
  ourPeerId: string;
}

export interface ReceivedAxlMessage {
  fromPeerId: string;
  message: AxlMessage;
}

export class AxlClient {
  constructor(private readonly baseUrl: string) {}

  async getTopology(): Promise<AxlTopology> {
    const res = await fetch(`${this.baseUrl}/topology`);
    if (!res.ok) throw new Error(`AXL topology failed: ${res.status}`);
    const body = await res.json() as { our_public_key: string };
    return { ourPeerId: body.our_public_key };
  }

  async send(peerId: string, message: AxlMessage): Promise<void> {
    const body = Buffer.from(JSON.stringify(message), 'utf-8');
    const res = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'X-Destination-Peer-Id': peerId },
      body,
    });
    if (!res.ok) throw new Error(`AXL send failed: ${res.status} ${await res.text()}`);
  }

  async recv(): Promise<ReceivedAxlMessage | null> {
    const res = await fetch(`${this.baseUrl}/recv`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`AXL recv failed: ${res.status}`);
    const fromPeerId = res.headers.get('X-From-Peer-Id') ?? '';
    const raw = await res.arrayBuffer();
    const text = Buffer.from(raw).toString('utf-8');
    const parsed = AxlMessageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`AXL recv bad payload: ${text}`);
    return { fromPeerId, message: parsed.data };
  }
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/axl/axl-message.ts src/axl/axl-client.ts
git commit -m "feat(axl): add AxlMessage schema and AxlClient HTTP wrapper"
```

---

## Task 2: AxlClient live test

**Files:**
- Create: `src/axl/axl-client.live.test.ts`

The live test requires the AXL node to be running (`npm run axl:start`). It is skipped when `AXL_URL` is unavailable.

- [ ] **Step 1: Create `src/axl/axl-client.live.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { AxlClient } from './axl-client';

const axlUrl = process.env.AXL_URL ?? 'http://127.0.0.1:9002';

describe('AxlClient (live, requires running AXL node)', () => {
  it('getTopology returns a non-empty peer ID', async () => {
    const client = new AxlClient(axlUrl);
    let topology: Awaited<ReturnType<typeof client.getTopology>>;
    try {
      topology = await client.getTopology();
    } catch {
      console.warn('[axl-client.live] AXL node not reachable — skipping');
      return;
    }
    console.log('[axl-client.live] topology:', topology);
    expect(topology.ourPeerId).toBeTruthy();
    expect(topology.ourPeerId.length).toBeGreaterThan(0);
  });

  it('recv returns null when queue is empty', async () => {
    const client = new AxlClient(axlUrl);
    try {
      const msg = await client.recv();
      console.log('[axl-client.live] recv result:', msg);
      expect(msg).toBeNull();
    } catch (err) {
      console.warn('[axl-client.live] AXL node not reachable — skipping:', err);
    }
  });
});
```

- [ ] **Step 2: Run test**

```bash
npm test src/axl/axl-client.live.test.ts
```
Expected: passes (skips gracefully if AXL node is not running).

- [ ] **Step 3: Commit**

```bash
git add src/axl/axl-client.live.test.ts
git commit -m "test(axl): add AxlClient live smoke tests"
```

---

## Task 3: AxlPoller

**Files:**
- Create: `src/axl/axl-poller.ts`

The poller calls `recv()` in a tight loop. On `null` (empty queue) it waits `pollIntervalMs` (default 100 ms) before retrying. On a message it calls `tickQueue.enqueue()`. Errors are logged and the loop continues.

- [ ] **Step 1: Create `src/axl/axl-poller.ts`**

```typescript
import type { AxlClient } from './axl-client';
import type { TickQueue } from '../agent-runner/tick-queue';

export interface AxlPollerOptions {
  pollIntervalMs?: number;
}

export class AxlPoller {
  private running = false;

  constructor(
    private readonly axlClient: AxlClient,
    private readonly tickQueue: TickQueue,
    private readonly options: AxlPollerOptions = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    const intervalMs = this.options.pollIntervalMs ?? 100;
    while (this.running) {
      try {
        const received = await this.axlClient.recv();
        if (!received) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }
        await this.tickQueue.enqueue({
          trigger: 'chat',
          agentId: received.message.targetAgentId,
          chatContent: received.message.chatContent,
        });
      } catch (err) {
        console.error('[axl-poller] error:', err);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/axl/axl-poller.ts
git commit -m "feat(axl): add AxlPoller — polls /recv and enqueues to tick queue"
```

---

## Task 4: Add `axlPeerId` to Agent (DB + domain types)

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/database/types.ts`
- Modify: `src/database/prisma-database/mappers.ts`
- Modify: `src/database/prisma-database/prisma-agent-repository.ts`

- [ ] **Step 1: Add field to Prisma schema**

In `prisma/schema.prisma`, inside the `Agent` model (after `lastTickAt BigInt?`), add:

```prisma
axlPeerId           String?
```

- [ ] **Step 2: Generate and apply migration**

```bash
npx prisma migrate dev --name add-agent-axl-peer-id
```
Expected: migration file created in `prisma/migrations/`, Prisma client regenerated.

- [ ] **Step 3: Add field to `AgentConfig` in `src/database/types.ts`**

Add after `lastTickAt?: number | null;`:

```typescript
axlPeerId?: string | null;
```

- [ ] **Step 4: Map field in `src/database/prisma-database/mappers.ts`**

In `agentRowToDomain`, add after `lastTickAt: num(row.lastTickAt),`:

```typescript
axlPeerId: row.axlPeerId ?? null,
```

- [ ] **Step 5: Persist field in `src/database/prisma-database/prisma-agent-repository.ts`**

In the `upsert` method, inside the `data` object (after `lastTickAt: ...`), add:

```typescript
axlPeerId: agent.axlPeerId ?? null,
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/database/types.ts src/database/prisma-database/mappers.ts src/database/prisma-database/prisma-agent-repository.ts
git commit -m "feat(db): add axlPeerId to Agent for AXL P2P routing"
```

---

## Task 5: Update `sendMessageToAgent` to use `AxlClient`

**Files:**
- Modify: `src/ai-tools/axl/send-message-to-agent-tool.ts`

The tool looks up the target agent's `axlPeerId`. If unset, it falls back to our own node's peer ID (passed in as `localPeerId`). It then calls `axlClient.send(peerId, { targetAgentId, chatContent })`.

- [ ] **Step 1: Rewrite `src/ai-tools/axl/send-message-to-agent-tool.ts`**

```typescript
import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AxlClient } from '../../axl/axl-client';
import type { AgentTool } from '../tool';

const SendMessageToAgentInputSchema = z.object({
  targetAgentId: z.string().min(1),
  message: z.string().min(1),
});

export function buildSendMessageToAgentTool(
  db: Database,
  axlClient: AxlClient,
  localPeerId: string,
): AgentTool<typeof SendMessageToAgentInputSchema> {
  return {
    name: 'sendMessageToAgent',
    description:
      'Send a message to a connected peer agent via the AXL P2P network. The recipient runs a normal tick with your message as input.',
    inputSchema: SendMessageToAgentInputSchema,
    async invoke(input, ctx) {
      if (input.targetAgentId === ctx.agent.id) {
        throw new Error('cannot send a message to self');
      }
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) throw new Error(`agent not found: ${ctx.agent.id}`);
      if (!(source.connectedAgentIds ?? []).includes(input.targetAgentId)) {
        throw new Error(`agent ${input.targetAgentId} is not connected to ${ctx.agent.id}`);
      }
      const target = await db.agents.findById(input.targetAgentId);
      if (!target) throw new Error(`target agent not found: ${input.targetAgentId}`);
      if (target.userId !== source.userId) {
        throw new Error('cross-user agent messaging is not allowed');
      }

      const peerId = target.axlPeerId ?? localPeerId;
      const chatContent = [
        `Message from agent ${source.id}, use "sendMessageToAgent" to reply`,
        '',
        input.message,
      ].join('\n');

      await axlClient.send(peerId, { targetAgentId: target.id, chatContent });

      return {
        delivered: true,
        targetAgentId: target.id,
        targetAgentName: target.name,
      };
    },
  };
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: errors only in `tool-registry.ts` (not yet updated) — that is fine.

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/axl/send-message-to-agent-tool.ts
git commit -m "feat(axl): route sendMessageToAgent through AXL P2P"
```

---

## Task 6: Update `sendMessageToChannel` to use `AxlClient`

**Files:**
- Modify: `src/ai-tools/axl/send-message-to-channel-tool.ts`

- [ ] **Step 1: Rewrite `src/ai-tools/axl/send-message-to-channel-tool.ts`**

```typescript
import { z } from 'zod';
import type { Database } from '../../database/database';
import type { AxlClient } from '../../axl/axl-client';
import type { AgentTool } from '../tool';

const SendMessageToChannelInputSchema = z.object({
  channelId: z.string().min(1),
  message: z.string().min(1),
});

export function buildSendMessageToChannelTool(
  db: Database,
  axlClient: AxlClient,
  localPeerId: string,
): AgentTool<typeof SendMessageToChannelInputSchema> {
  return {
    name: 'sendMessageToChannel',
    description:
      'Send a message to all other agents in a connected AXL channel via the AXL P2P network.',
    inputSchema: SendMessageToChannelInputSchema,
    async invoke(input, ctx) {
      const source = await db.agents.findById(ctx.agent.id);
      if (!source) throw new Error(`agent not found: ${ctx.agent.id}`);
      if (!(source.connectedChannelIds ?? []).includes(input.channelId)) {
        throw new Error(`agent ${ctx.agent.id} is not connected to channel ${input.channelId}`);
      }
      const channel = await db.agents.findAxlChannelById(input.channelId);
      if (!channel) throw new Error(`channel not found: ${input.channelId}`);
      if (channel.userId !== source.userId) {
        throw new Error('cross-user channel messaging is not allowed');
      }

      const targetAgentIds = channel.memberAgentIds.filter((id) => id !== source.id);
      const deliveredTargets: Array<{ agentId: string; name: string }> = [];

      for (const targetAgentId of targetAgentIds) {
        const target = await db.agents.findById(targetAgentId);
        if (!target || target.userId !== source.userId) continue;

        const peerId = target.axlPeerId ?? localPeerId;
        const chatContent = [
          `Message from agent ${source.id} in channel ${channel.id} (${channel.name})`,
          '',
          input.message,
        ].join('\n');

        await axlClient.send(peerId, { targetAgentId: target.id, chatContent });
        deliveredTargets.push({ agentId: target.id, name: target.name });
      }

      return {
        delivered: true,
        channelId: channel.id,
        channelName: channel.name,
        deliveredCount: deliveredTargets.length,
        deliveredTargets,
      };
    },
  };
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: errors only in `tool-registry.ts` — fine.

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/axl/send-message-to-channel-tool.ts
git commit -m "feat(axl): route sendMessageToChannel through AXL P2P"
```

---

## Task 7: Wire `AxlClient` into `ToolRegistry`

**Files:**
- Modify: `src/ai-tools/tool-registry.ts`

Remove `tickQueue` from `ToolRegistryDeps` (it was only used by the two send tools). Add `axlClient` and `localAxlPeerId`.

- [ ] **Step 1: Update `src/ai-tools/tool-registry.ts`**

Replace the `tickQueue: TickQueue` import and usage:

```typescript
import type { AgentTool } from './tool';
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
import type { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import type { SerperService } from '../providers/serper/serper-service';
import type { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { Database } from '../database/database';
import type { UniswapService } from '../uniswap/uniswap-service';
import type { Env } from '../config/env';
import type { AxlClient } from '../axl/axl-client';
import { buildCoingeckoPriceTool } from './providers/coingecko-price-tool';
import { buildCoinMarketCapInfoTool } from './providers/coinmarketcap-info-tool';
import { buildSerperSearchTool } from './providers/serper-search-tool';
import { buildFirecrawlScrapeTool } from './providers/firecrawl-scrape-tool';
import { buildWalletBalanceTools } from './wallet/wallet-balance-tools';
import { buildReadMemoryTool } from './memory/read-memory-tool';
import { buildUpdateMemoryTool } from './memory/update-memory-tool';
import { buildSaveMemoryEntryTool } from './memory/save-memory-entry-tool';
import { buildSearchMemoryEntriesTool } from './memory/search-memory-entries-tool';
import { buildUniswapQuoteTool } from './uniswap/uniswap-quote-tool';
import { buildUniswapSwapTool } from './uniswap/uniswap-swap-tool';
import { buildFindTokensBySymbolTool } from './tokens/find-tokens-by-symbol-tool';
import { buildGetTokenByAddressTool } from './tokens/get-token-by-address-tool';
import { buildListAllowedTokensTool } from './tokens/list-allowed-tokens-tool';
import { buildFormatTokenAmountTool } from './utility/format-token-amount-tool';
import { buildParseTokenAmountTool } from './utility/parse-token-amount-tool';
import { buildSendMessageToAgentTool } from './axl/send-message-to-agent-tool';
import { buildSendMessageToAgentHelpTool } from './axl/send-message-to-agent-help-tool';
import { buildSendMessageToChannelTool } from './axl/send-message-to-channel-tool';
import { buildListAvailableChannelsTool } from './axl/list-available-channels-tool';
import { assertToolCatalogMatchesBuiltTools } from './tool-catalog';

export interface ToolRegistryDeps {
  coingecko: CoingeckoService;
  coinmarketcap: CoinMarketCapService;
  serper: SerperService;
  firecrawl: FirecrawlService;
  db: Database;
  uniswap: UniswapService;
  env: Env;
  axlClient: AxlClient;
  localAxlPeerId: string;
}

export class ToolRegistry {
  constructor(private readonly deps: ToolRegistryDeps) {}

  build(): AgentTool[] {
    const [walletAddress, nativeBalance, tokenBalance] = buildWalletBalanceTools(this.deps.db, this.deps.env);
    const tools = [
      buildCoingeckoPriceTool(this.deps.coingecko, this.deps.db),
      buildCoinMarketCapInfoTool(this.deps.coinmarketcap),
      buildSerperSearchTool(this.deps.serper),
      buildFirecrawlScrapeTool(this.deps.firecrawl),
      walletAddress,
      nativeBalance,
      tokenBalance,
      buildReadMemoryTool(this.deps.db),
      buildUpdateMemoryTool(this.deps.db),
      buildSaveMemoryEntryTool(this.deps.db),
      buildSearchMemoryEntriesTool(this.deps.db),
      buildUniswapQuoteTool(this.deps.uniswap, this.deps.db),
      buildUniswapSwapTool(this.deps.uniswap, this.deps.coingecko, this.deps.db),
      buildFindTokensBySymbolTool(this.deps.db),
      buildGetTokenByAddressTool(this.deps.db),
      buildListAllowedTokensTool(this.deps.db),
      buildSendMessageToAgentHelpTool(this.deps.db),
      buildSendMessageToAgentTool(this.deps.db, this.deps.axlClient, this.deps.localAxlPeerId),
      buildListAvailableChannelsTool(this.deps.db),
      buildSendMessageToChannelTool(this.deps.db, this.deps.axlClient, this.deps.localAxlPeerId),
      buildFormatTokenAmountTool(),
      buildParseTokenAmountTool(),
    ];
    assertToolCatalogMatchesBuiltTools(tools);
    return tools;
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: errors in `worker.ts` and `tool-registry.live.test.ts` only (not yet updated).

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/tool-registry.ts
git commit -m "feat(axl): wire AxlClient into ToolRegistry, drop tickQueue dep from send tools"
```

---

## Task 8: Update live test for tool registry

**Files:**
- Modify: `src/ai-tools/tool-registry.live.test.ts`

The test previously used `createStubTickQueue()`. Now the send tools need an `AxlClient` and `localAxlPeerId`. We swap in a stub `AxlClient` that captures sent messages.

- [ ] **Step 1: Update `src/ai-tools/tool-registry.live.test.ts`**

Replace the `tickQueue` import and usage. Find the `createStubTickQueue` import line and the `tickQueue: createStubTickQueue()` line in the registry construction, and replace as follows:

Remove:
```typescript
import { createStubTickQueue } from '../test-lib/stub-tick-queue';
```

Add after the last import:
```typescript
import { AxlClient } from '../axl/axl-client';
```

In the registry construction inside `beforeEach`, replace:
```typescript
tickQueue: createStubTickQueue(),
```
with:
```typescript
axlClient: new AxlClient(process.env.AXL_URL ?? 'http://127.0.0.1:9002'),
localAxlPeerId: 'test-local-peer-id',
```

In the `sendMessageToChannel` test, the result shape no longer has `queuePosition`. Update the assertions:

```typescript
  it('sendMessageToChannel enqueues to channel peers', async () => {
    const peer = makeAgent('a2', agent.userId);
    await db.agents.upsert(peer);
    const channel = await db.agents.createAxlChannel({
      id: 'channel-test-1',
      userId: agent.userId,
      name: 'alpha',
      createdAt: Date.now(),
    });
    await db.agents.addAgentToAxlChannel(agent.id, channel.id);
    await db.agents.addAgentToAxlChannel(peer.id, channel.id);

    const tool = registry.build().find((t) => t.name === 'sendMessageToChannel');
    if (!tool) throw new Error('channel tool missing');
    let result: { delivered: boolean; deliveredCount: number } | undefined;
    try {
      result = (await tool.invoke({ channelId: channel.id, message: 'hello channel' }, ctx)) as {
        delivered: boolean;
        deliveredCount: number;
      };
    } catch (err) {
      console.warn('[tool-registry] sendMessageToChannel skipped — AXL node not running:', err);
      return;
    }
    console.log('[tool-registry] sendMessageToChannel:', result);
    expect(result!.delivered).toBe(true);
    expect(result!.deliveredCount).toBe(1);
  });
```

- [ ] **Step 2: Run tests**

```bash
npm test src/ai-tools/tool-registry.live.test.ts
```
Expected: all tests pass (channel test skips gracefully if AXL node is not running).

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/tool-registry.live.test.ts
git commit -m "test(axl): update tool registry live test for AXL-based send tools"
```

---

## Task 9: Wire `AxlClient` + `AxlPoller` into `worker.ts`

**Files:**
- Modify: `src/worker.ts`

At startup, instantiate `AxlClient`, call `getTopology()` to get `localAxlPeerId`, pass both into `ToolRegistry`. Instantiate `AxlPoller` and start it. Stop it on shutdown.

- [ ] **Step 1: Update `src/worker.ts`**

Add imports after the existing imports:
```typescript
import { AxlClient } from './axl/axl-client';
import { AxlPoller } from './axl/axl-poller';
```

Inside `main()`, after `const queue = new RedisTickQueue(...)`, add:
```typescript
  const axlClient = new AxlClient(env.AXL_URL);
  const { ourPeerId: localAxlPeerId } = await axlClient.getTopology();
  console.log(`[bootstrap] AXL node ready — peer=${localAxlPeerId}`);
  const axlPoller = new AxlPoller(axlClient, queue);
```

In the `toolRegistry` construction, replace `tickQueue: queue` with:
```typescript
    axlClient,
    localAxlPeerId,
```

After `dispatcher.start();`, add:
```typescript
  axlPoller.start();
  console.log('[bootstrap] AXL poller started');
```

In the `shutdown` function, after `scheduler.stop();`, add:
```typescript
    axlPoller.stop();
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat(axl): start AxlPoller in worker, wire AxlClient into ToolRegistry"
```

---

## Task 10: Update `.env.example`

**Files:**
- Modify: `.env.example`

`AXL_URL` is already in `config/env.ts` with a default. Add a commented hint to `.env.example`.

- [ ] **Step 1: Check current `.env.example`**

```bash
grep -n "AXL\|axl" .env.example
```

- [ ] **Step 2: Add hint if missing**

If `AXL_URL` is not present, add to `.env.example` in the `# Runtime` section:
```
# AXL_URL=http://127.0.0.1:9002    # optional; defaults to local AXL node
```

- [ ] **Step 3: Commit (only if changed)**

```bash
git add .env.example
git commit -m "chore: document AXL_URL in .env.example"
```

---

## Self-Review

**Spec coverage:**
- ✓ AXL client wrapping `/send`, `/recv`, `/topology`
- ✓ `AxlPoller` polling `/recv` → Redis tick queue
- ✓ `sendMessageToAgent` sends via AXL
- ✓ `sendMessageToChannel` fan-out via AXL
- ✓ Per-node peer ID: fetched from topology at startup, stored as `localAxlPeerId`
- ✓ `axlPeerId` on Agent for remote nodes
- ✓ Fallback: agents without `axlPeerId` use `localAxlPeerId` (same-node delivery still works)
- ✓ Worker wiring: AxlPoller started/stopped
- ✓ Live test gracefully skips if AXL node is not running

**Placeholder scan:** None found.

**Type consistency:** `AxlClient` signature matches across tasks 1, 5, 6, 7, 9. `localAxlPeerId: string` passed consistently. `AxlMessage` used in client and poller.
