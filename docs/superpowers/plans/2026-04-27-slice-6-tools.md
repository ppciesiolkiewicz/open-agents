# Slice 6 — AI tools surface (native OpenAI tool calling)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM can call tools. Wrap providers (Coingecko, CMC, Serper, Firecrawl), wallet balance reads, and four memory tools (read / update / saveEntry / search) as native OpenAI function-calling tools. `AgentRunner` owns the tool-call loop using returned `tool_calls` from `LLMClient.invokeWithTools` — no Langchain.

**Architecture:** Keep slice 4-5 abstractions intact. Extend `LLMClient` with `invokeWithTools(messages, tools, ctx)` that does ONE HTTP call and returns either content (done) or `tool_calls` (more work). `AgentRunner` runs the loop: dispatch tools concurrently per assistant message, append tool messages, ask LLM again, until plain text or `MAX_TOOL_ROUNDS_PER_TICK` reached. Memory schema gains an `entries: MemoryEntry[]` array so the LLM can save snapshots/observations/gists and search them later — `embedding?: number[]` field reserved for future similarity search.

**Tech Stack:** `openai` (already installed slice 5), `zod-to-json-schema` (new, ~5KB), our existing `LLMClient` interface, `AgentActivityLog`, `WalletFactory`. NO Langchain.

**Spec reference:** [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](../specs/2026-04-26-agent-loop-foundation-design.md) — section "Tools".

**Test rule (slice 6):**
- Pure-logic tests use `*.test.ts` (e.g., `ToolRegistry.toolsForAgent` name list assertion)
- I/O-touching tests use `*.live.test.ts` (real HTTP, real fs)
- Tools that wrap a service get exercised by `tool-registry.live.test.ts` rather than each having a separate file

---

## File Structure

```
src/constants/
  agent-runner.ts                          # NEW — AGENT_RUNNER constants (maxToolRoundsPerTick)
  tokens.ts                                # MODIFY — add coingeckoId per token
  index.ts                                 # MODIFY — re-export agent-runner constants
src/database/
  types.ts                                 # MODIFY — extend AgentMemory with entries; add MemoryEntry
  file-database/
    file-agent-memory-repository.ts        # MODIFY — backfill entries=[] on legacy reads
src/agent-runner/
  llm-client.ts                            # MODIFY — extend with invokeWithTools, ToolDefinition, ChatMessage types
  stub-llm-client.ts                       # MODIFY — invokeWithTools delegates to invoke
  agent-runner.ts                          # REWRITE — orchestrate tool loop
  agent-runner.live.test.ts                # REWRITE — uses ScriptedLLMClient
src/ai/chat-model/
  zerog-llm-client.ts                      # MODIFY — implement invokeWithTools
src/ai-tools/
  tool.ts                                  # NEW — AgentTool, AgentToolContext, ToolInvocationResult
  tool-registry.ts                         # NEW — composes per-agent tools
  tool-registry.test.ts                    # NEW — pure-logic name list assertion
  tool-registry.live.test.ts               # NEW — exercises providers/wallet/memory tools
  zod-to-openai.ts                         # NEW — zod schema → OpenAI function tool format
  providers/
    coingecko-price-tool.ts                # NEW
    coinmarketcap-info-tool.ts             # NEW
    serper-search-tool.ts                  # NEW
    firecrawl-scrape-tool.ts               # NEW
  wallet/
    wallet-balance-tools.ts                # NEW (returns 2 tools)
  memory/
    read-memory-tool.ts                    # NEW
    update-memory-tool.ts                  # NEW
    save-memory-entry-tool.ts              # NEW
    search-memory-entries-tool.ts          # NEW
src/index.ts                                # MODIFY — instantiate ToolRegistry; pass to AgentRunner
package.json                                # MODIFY — add zod-to-json-schema
```

---

## Task 1: Install `zod-to-json-schema` + add MAX_TOOL_ROUNDS_PER_TICK constant

**Files:**
- Modify: `package.json`
- Create: `src/constants/agent-runner.ts`
- Modify: `src/constants/index.ts`

- [ ] **Step 1: Install dep**

```bash
npm install zod-to-json-schema
```

Expected: `package.json` `dependencies` gets `zod-to-json-schema` (~^3.x).

- [ ] **Step 2: Create `src/constants/agent-runner.ts`**

```ts
export const AGENT_RUNNER = {
  // Hard cap on LLM↔tool round-trips inside a single agent tick.
  // Each round = one LLM call, possibly with tool dispatches before the next.
  // Cap exists so a confused LLM cannot loop forever; if hit we log an error
  // entry and end the tick.
  maxToolRoundsPerTick: 10,
} as const;
```

- [ ] **Step 3: Re-export from `src/constants/index.ts`**

Append a line:

```ts
export * from './agent-runner';
```

(Keep all existing re-exports.)

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/constants/agent-runner.ts src/constants/index.ts
git commit -m "feat(constants): add AGENT_RUNNER.maxToolRoundsPerTick + install zod-to-json-schema"
```

---

## Task 2: Add `coingeckoId` to `TOKENS`

**Files:**
- Modify: `src/constants/tokens.ts`

- [ ] **Step 1: Replace contents**

```ts
export interface TokenInfo {
  address: `0x${string}`;
  decimals: number;
  symbol: string;
  coingeckoId: string;
}

export const TOKENS = {
  USDC: {
    address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    decimals: 6,
    symbol: 'USDC',
    coingeckoId: 'usd-coin',
  },
  UNI: {
    address: '0x8f187aA05619a017077f5308904739877ce9eA21',
    decimals: 18,
    symbol: 'UNI',
    coingeckoId: 'uniswap',
  },
} as const satisfies Record<string, TokenInfo>;

export type TokenSymbol = keyof typeof TOKENS;
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0. (Existing constants tests don't assert `coingeckoId`, so they still pass.)

- [ ] **Step 3: Commit**

```bash
git add src/constants/tokens.ts
git commit -m "feat(constants): add coingeckoId to TOKENS for slice 6 price tool"
```

---

## Task 3: Extend `AgentMemory` with `entries[]` + `MemoryEntry`

**Files:**
- Modify: `src/database/types.ts`

The structural change adds `entries: MemoryEntry[]` to `AgentMemory`. v1 `MemoryEntry` carries `type`, `content`, `tickId`, `parentEntryIds?`, and an `embedding?: number[]` field reserved for future similarity search (slice 9+) — no embedder in v1, so the field is just structurally present.

- [ ] **Step 1: Update the file**

Find the existing `AgentMemory` interface:

```ts
export interface AgentMemory {
  agentId: string;
  notes: string;
  state: Record<string, unknown>;
  updatedAt: number;
}
```

Replace with:

```ts
export type MemoryEntryType = 'snapshot' | 'observation' | 'gist' | 'note';

export interface MemoryEntry {
  id: string;
  tickId: string;
  type: MemoryEntryType;
  content: string;
  parentEntryIds?: string[];   // a 'gist' may reference the entries it summarizes
  embedding?: number[];        // reserved for future similarity search; null/absent in v1
  createdAt: number;
}

export interface AgentMemory {
  agentId: string;
  notes: string;
  state: Record<string, unknown>;
  updatedAt: number;
  entries: MemoryEntry[];      // append-only history; populated by saveMemoryEntry tool
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: typecheck FAILS — slice 4 test files construct `AgentMemory` literals without the new `entries` field. That's expected; Tasks 4 + 13 close the gaps. List the failures in your report.

- [ ] **Step 3: Commit**

```bash
git add src/database/types.ts
git commit -m "feat(database): extend AgentMemory with entries[]; add MemoryEntry + MemoryEntryType"
```

---

## Task 4: Backfill `entries=[]` in `FileAgentMemoryRepository.get`

**Files:**
- Modify: `src/database/file-database/file-agent-memory-repository.ts`

Existing `db/memory/<agentId>.json` files lack the new `entries` field. Inject `entries: []` when missing so consumers always see a well-formed `AgentMemory`.

Also fix the slice 4 + slice 5 test sites that construct `AgentMemory` literals directly — Task 13 will rewrite the agent-runner test, so address only the type files now.

- [ ] **Step 1: Find the existing `get` method**

```ts
async get(agentId: string): Promise<AgentMemory | null> {
  try {
    const raw = await readFile(this.pathFor(agentId), 'utf8');
    return JSON.parse(raw) as AgentMemory;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
```

Replace with:

```ts
async get(agentId: string): Promise<AgentMemory | null> {
  try {
    const raw = await readFile(this.pathFor(agentId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentMemory> & { agentId: string };
    return {
      agentId: parsed.agentId,
      notes: parsed.notes ?? '',
      state: parsed.state ?? {},
      updatedAt: parsed.updatedAt ?? 0,
      entries: parsed.entries ?? [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: still FAILS in agent-runner tests (Task 13 fixes them). FileDatabase code itself should compile cleanly.

- [ ] **Step 3: Run the FileDatabase live test**

Run: `npx vitest run src/database/file-database/`
Expected: 9 tests still pass — the existing tests construct `AgentMemory` with `entries` missing from JSON, the backfill returns `entries: []`. The expectation `expect(loaded).toEqual(mem)` may now fail because the loaded object has an extra `entries: []` field.

If a test asserts `toEqual` on an `AgentMemory` literal that lacks `entries`, update that test literal to include `entries: []`. Specifically the test "round-trips AgentMemory in its own per-agent file" at `src/database/file-database/file-database.live.test.ts` constructs:

```ts
const mem: AgentMemory = {
  agentId: 'a1',
  notes: 'short MA below long MA',
  state: { priceHistory: [3.21, 3.22, 3.20] },
  updatedAt: Date.now(),
};
```

Add `entries: []` so the literal matches the new type:

```ts
const mem: AgentMemory = {
  agentId: 'a1',
  notes: 'short MA below long MA',
  state: { priceHistory: [3.21, 3.22, 3.20] },
  updatedAt: Date.now(),
  entries: [],
};
```

- [ ] **Step 4: Re-run the FileDatabase test**

Run: `npx vitest run src/database/file-database/`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/database/file-database/file-agent-memory-repository.ts src/database/file-database/file-database.live.test.ts
git commit -m "feat(database): backfill AgentMemory.entries on legacy reads; update test fixture"
```

---

## Task 5: Extend `LLMClient` with tool-calling shape + `invokeWithTools`

**Files:**
- Modify: `src/agent-runner/llm-client.ts`

This is the new contract that both `ZeroGLLMClient` and `StubLLMClient` implement.

- [ ] **Step 1: Replace the file's contents**

```ts
import type { ZodTypeAny } from 'zod';

export interface LLMResponse {
  content: string;
  tokenCount?: number;
}

// Tool descriptor as the LLM sees it. The actual function body lives in AgentTool;
// LLMClient only needs the schema for the chat completion call.
export interface ToolDefinition {
  name: string;
  description: string;
  parametersSchema: ZodTypeAny;
}

// One call from the model asking us to run a tool.
export interface ToolCall {
  id: string;             // OpenAI tool_call id; must round-trip in the tool reply message
  name: string;
  argumentsJson: string;  // raw JSON; AgentRunner parses + zod-validates against the matching ToolDefinition
}

// One reply the runner sends back to the model after running a tool.
export interface ToolReply {
  toolCallId: string;     // matches ToolCall.id
  content: string;        // tool output OR error message ('error: <message>')
}

// Conversation transcript shape the runner accumulates between rounds.
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LLMTurnResult {
  // Either content (model is done) or toolCalls (model wants more work) or both.
  content?: string;
  toolCalls?: ToolCall[];
  tokenCount?: number;
  // Pass-through of the raw assistant message; AgentRunner pushes this into the
  // history before sending tool replies.
  assistantMessage: ChatMessage;
}

export interface LLMClient {
  modelName(): string;

  // Single-shot completion. Used by paths that don't need tools (e.g. summarization).
  invoke(prompt: string): Promise<LLMResponse>;

  // One round of a tool-calling loop. ONE HTTP call. Returns either content (done)
  // or tool_calls (more work needed). AgentRunner owns the loop.
  invokeWithTools(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMTurnResult>;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: typecheck FAILS — `ZeroGLLMClient` and `StubLLMClient` don't yet implement `invokeWithTools`. Tasks 6 + 7 close the gaps.

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/llm-client.ts
git commit -m "feat(agent-runner): extend LLMClient with invokeWithTools + ChatMessage/ToolDefinition/ToolCall types"
```

---

## Task 6: Implement `invokeWithTools` in `ZeroGLLMClient`

**Files:**
- Modify: `src/ai/chat-model/zerog-llm-client.ts`

- [ ] **Step 1: Add the helper that converts our `ToolDefinition` to the OpenAI tool shape**

At the top of the file, after the existing imports, add:

```ts
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  ChatMessage,
  LLMTurnResult,
  ToolCall,
  ToolDefinition,
} from '../../agent-runner/llm-client';

function toOpenAITool(def: ToolDefinition): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: zodToJsonSchema(def.parametersSchema, { target: 'openApi3' }) as Record<string, unknown>,
    },
  };
}

function toOpenAIMessage(msg: ChatMessage): ChatCompletionMessageParam {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: msg.content };
    case 'user':
      return { role: 'user', content: msg.content };
    case 'tool':
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: msg.content,
        ...(msg.toolCalls && msg.toolCalls.length > 0
          ? {
              tool_calls: msg.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.argumentsJson },
              })),
            }
          : {}),
      };
  }
}
```

- [ ] **Step 2: Add the `invokeWithTools` method to the class**

Inside the `ZeroGLLMClient` class, after the existing `invoke` method, add:

```ts
  async invokeWithTools(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMTurnResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.invokeWithToolsOnce(messages, tools);
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    }
    throw lastErr;
  }

  private async invokeWithToolsOnce(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMTurnResult> {
    const headers = (await this.broker.inference.getRequestHeaders(this.providerAddress)) as unknown as Record<string, string>;
    const completion = await this.openai.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
      },
      { headers },
    );

    const choice = completion.choices[0];
    if (!choice) throw new Error('0G provider returned no completion choices');

    const content = choice.message.content ?? '';
    const tokenCount = completion.usage?.total_tokens;

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      }));

    // Best-effort settlement validation (slice 5 behavior preserved).
    try {
      const isValid = await this.broker.inference.processResponse(
        this.providerAddress,
        completion.id,
        content,
      );
      if (isValid !== true) {
        console.warn(`[zerog-llm] processResponse returned ${isValid}; provider settlement may have rejected or could not verify this call`);
      }
    } catch (err) {
      console.warn('[zerog-llm] processResponse threw:', (err as Error).message);
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      ...(content.length > 0 ? { content } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(tokenCount !== undefined ? { tokenCount } : {}),
      assistantMessage,
    };
  }
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: typecheck FAILS only in `StubLLMClient` (Task 7 fixes it) and the agent-runner test files (Task 13 fixes them).

- [ ] **Step 4: Run the existing ZeroG LLM live test**

Run: `npx vitest run src/ai/chat-model/`
Expected: same outcome as before — SKIPPED (no bootstrap.json) or 2 pass. The new `invokeWithTools` method is not yet exercised; no regressions in `invoke`.

- [ ] **Step 5: Commit**

```bash
git add src/ai/chat-model/zerog-llm-client.ts
git commit -m "feat(ai/chat-model): implement invokeWithTools on ZeroGLLMClient (single round, retry)"
```

---

## Task 7: Implement `invokeWithTools` in `StubLLMClient`

**Files:**
- Modify: `src/agent-runner/stub-llm-client.ts`

The stub doesn't actually call tools — `invokeWithTools` builds a prompt from the message history and delegates to `invoke`, returning content only.

- [ ] **Step 1: Replace the file's contents**

```ts
import type {
  ChatMessage,
  LLMClient,
  LLMResponse,
  LLMTurnResult,
  ToolDefinition,
} from './llm-client';

// Production stub used until slice 5 replaces it with the 0G-backed client.
export class StubLLMClient implements LLMClient {
  modelName(): string {
    return 'stub';
  }

  async invoke(prompt: string): Promise<LLMResponse> {
    const head = prompt.slice(0, 80).replace(/\s+/g, ' ');
    return {
      content: `[stub-llm] received ${prompt.length}-char prompt; would reason about: "${head}"`,
    };
  }

  async invokeWithTools(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<LLMTurnResult> {
    // Stub doesn't actually call tools — flatten the message history into a
    // single prompt and return canned text. Loop in AgentRunner terminates
    // immediately because no toolCalls are returned.
    const flat = messages
      .map((m) => {
        if (m.role === 'tool') return `[tool ${m.toolCallId}]: ${m.content}`;
        if (m.role === 'assistant') return `[assistant]: ${m.content}`;
        return `[${m.role}]: ${m.content}`;
      })
      .join('\n');
    const single = await this.invoke(flat);
    return {
      content: single.content,
      assistantMessage: { role: 'assistant', content: single.content },
    };
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: typecheck still fails in agent-runner files (Task 13 closes those gaps), but `StubLLMClient` itself compiles.

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/stub-llm-client.ts
git commit -m "feat(agent-runner): implement invokeWithTools on StubLLMClient (no-op pass-through)"
```

---

## Task 8: `AgentTool` framework + `zod-to-openai` adapter

**Files:**
- Create: `src/ai-tools/tool.ts`
- Create: `src/ai-tools/zod-to-openai.ts`

- [ ] **Step 1: Create `src/ai-tools/tool.ts`**

```ts
import type { ZodTypeAny, z } from 'zod';
import type { AgentConfig } from '../database/types';
import type { Wallet } from '../wallet/wallet';

// Context the runner injects into each tool invocation.
export interface AgentToolContext {
  agent: AgentConfig;
  wallet: Wallet;
  tickId: string;
}

// One tool. Generic over the parsed input shape (after zod validation) and the
// raw JSON-serializable output the LLM will see as the tool message content.
export interface AgentTool<TInput extends ZodTypeAny = ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  invoke(input: z.infer<TInput>, ctx: AgentToolContext): Promise<unknown>;
}
```

- [ ] **Step 2: Create `src/ai-tools/zod-to-openai.ts`**

```ts
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentTool } from './tool';
import type { ToolDefinition } from '../agent-runner/llm-client';

// AgentTool → ToolDefinition (the LLM-facing descriptor).
// JSON Schema generation runs once per build of the tool list (per-tick).
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parametersSchema: tool.inputSchema,
  };
}

// Convenience for callers that already need the OpenAI-shaped JSON schema
// (e.g. the smoke test that asserts the tool surface is well-formed).
export function toOpenAIFunctionSchema(tool: AgentTool): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>,
  };
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: still fails in slice 4 test files. New files compile cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/ai-tools/tool.ts src/ai-tools/zod-to-openai.ts
git commit -m "feat(ai-tools): add AgentTool interface + zod-to-openai schema adapter"
```

---

## Task 9: Provider tools (Coingecko, CMC, Serper, Firecrawl)

**Files:**
- Create: `src/ai-tools/providers/coingecko-price-tool.ts`
- Create: `src/ai-tools/providers/coinmarketcap-info-tool.ts`
- Create: `src/ai-tools/providers/serper-search-tool.ts`
- Create: `src/ai-tools/providers/firecrawl-scrape-tool.ts`

- [ ] **Step 1: `coingecko-price-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { TOKENS } from '../../constants';

const inputSchema = z.object({
  symbol: z.string().describe('Token symbol like USDC or UNI'),
});

export function buildCoingeckoPriceTool(svc: CoingeckoService): AgentTool<typeof inputSchema> {
  return {
    name: 'fetchTokenPriceUSD',
    description:
      'Fetch the current USD price for a token symbol (e.g. "USDC", "UNI"). Returns JSON {symbol, priceUSD}.',
    inputSchema,
    async invoke({ symbol }) {
      const upper = symbol.toUpperCase();
      const known = (TOKENS as Record<string, { coingeckoId: string }>)[upper];
      const id = known?.coingeckoId ?? symbol.toLowerCase();
      const price = await svc.fetchTokenPriceUSD(id);
      return { symbol: upper, priceUSD: price };
    },
  };
}
```

- [ ] **Step 2: `coinmarketcap-info-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { CoinMarketCapService } from '../../providers/coinmarketcap/coinmarketcap-service';

const inputSchema = z.object({
  symbol: z.string().describe('Token symbol like USDC or UNI'),
});

export function buildCoinMarketCapInfoTool(svc: CoinMarketCapService): AgentTool<typeof inputSchema> {
  return {
    name: 'fetchTokenInfoBySymbol',
    description:
      'Fetch project metadata (id, name, slug) for a token symbol from CoinMarketCap.',
    inputSchema,
    async invoke({ symbol }) {
      const info = await svc.fetchTokenInfoBySymbol(symbol.toUpperCase());
      return { id: info.id, name: info.name, symbol: info.symbol, slug: info.slug };
    },
  };
}
```

- [ ] **Step 3: `serper-search-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { SerperService } from '../../providers/serper/serper-service';

const MAX_RESULTS = 5;

const inputSchema = z.object({
  query: z.string().describe('Search query'),
});

export function buildSerperSearchTool(svc: SerperService): AgentTool<typeof inputSchema> {
  return {
    name: 'searchWeb',
    description:
      'Search Google via Serper and return the top 5 organic results as an array of {title, link, snippet}.',
    inputSchema,
    async invoke({ query }) {
      const results = await svc.searchWeb(query);
      return results.slice(0, MAX_RESULTS).map((r) => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet,
      }));
    },
  };
}
```

- [ ] **Step 4: `firecrawl-scrape-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { FirecrawlService } from '../../providers/firecrawl/firecrawl-service';

const MAX_CHARS = 4_000;

const inputSchema = z.object({
  url: z.string().describe('Absolute URL to scrape'),
});

export function buildFirecrawlScrapeTool(svc: FirecrawlService): AgentTool<typeof inputSchema> {
  return {
    name: 'scrapeUrlMarkdown',
    description:
      'Scrape a URL and return its content as markdown (truncated to 4000 chars).',
    inputSchema,
    async invoke({ url }) {
      const md = await svc.scrapeUrlMarkdown(url);
      return md.length > MAX_CHARS ? md.slice(0, MAX_CHARS) + '\n...[truncated]' : md;
    },
  };
}
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: tool files compile cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/ai-tools/providers/
git commit -m "feat(ai-tools): add provider tool wrappers (coingecko, cmc, serper, firecrawl)"
```

---

## Task 10: Wallet balance tools

**Files:**
- Create: `src/ai-tools/wallet/wallet-balance-tools.ts`

- [ ] **Step 1: Implement**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';

const nativeInput = z.object({}).describe('No arguments required');
const tokenInput = z.object({
  tokenAddress: z.string().describe('ERC-20 contract address (0x-prefixed)'),
});

export function buildWalletBalanceTools(): [
  AgentTool<typeof nativeInput>,
  AgentTool<typeof tokenInput>,
] {
  const nativeBalance: AgentTool<typeof nativeInput> = {
    name: 'getNativeBalance',
    description:
      'Read the native (ETH) balance for the agent wallet on Unichain. Returns JSON {raw, unit:"wei"}. raw is a bigint as string.',
    inputSchema: nativeInput,
    async invoke(_input, ctx) {
      const wei = await ctx.wallet.getNativeBalance();
      return { raw: wei.toString(), unit: 'wei' };
    },
  };

  const tokenBalance: AgentTool<typeof tokenInput> = {
    name: 'getTokenBalance',
    description:
      'Read the ERC-20 balance for the agent wallet on Unichain. Returns JSON {tokenAddress, raw}. raw is a bigint as string in token base units (no decimal scaling).',
    inputSchema: tokenInput,
    async invoke({ tokenAddress }, ctx) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
        throw new Error(`tokenAddress must be a 0x-prefixed 40-char hex address; got ${tokenAddress}`);
      }
      const raw = await ctx.wallet.getTokenBalance(tokenAddress as `0x${string}`);
      return { tokenAddress, raw: raw.toString() };
    },
  };

  return [nativeBalance, tokenBalance];
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: file compiles.

- [ ] **Step 3: Commit**

```bash
git add src/ai-tools/wallet/wallet-balance-tools.ts
git commit -m "feat(ai-tools): add wallet balance tools (native + ERC-20)"
```

---

## Task 11: Memory tools (read, update, saveEntry, searchEntries)

**Files:**
- Create: `src/ai-tools/memory/read-memory-tool.ts`
- Create: `src/ai-tools/memory/update-memory-tool.ts`
- Create: `src/ai-tools/memory/save-memory-entry-tool.ts`
- Create: `src/ai-tools/memory/search-memory-entries-tool.ts`

- [ ] **Step 1: `read-memory-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';

const DEFAULT_RECENT_ENTRIES = 20;

const inputSchema = z.object({
  recentEntries: z.number().int().min(0).max(200).optional()
    .describe('How many of the most-recent memory entries to return (default 20).'),
});

export function buildReadMemoryTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'readMemory',
    description:
      'Read your current persistent memory: structured state, free-form notes, and the most recent memory entries. Returns JSON {state, notes, recentEntries}.',
    inputSchema,
    async invoke({ recentEntries }, ctx) {
      const limit = recentEntries ?? DEFAULT_RECENT_ENTRIES;
      const mem = (await db.agentMemory.get(ctx.agent.id)) ?? {
        agentId: ctx.agent.id,
        notes: '',
        state: {},
        updatedAt: 0,
        entries: [],
      };
      return {
        state: mem.state,
        notes: mem.notes,
        recentEntries: mem.entries.slice(-limit),
      };
    },
  };
}
```

- [ ] **Step 2: `update-memory-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import type { AgentMemory } from '../../database/types';

const inputSchema = z.object({
  state: z.record(z.unknown()).optional()
    .describe('Replacement state object. Omit to keep existing state.'),
  appendNote: z.string().optional()
    .describe('Note to append (a timestamp prefix is added).'),
});

export function buildUpdateMemoryTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'updateMemory',
    description:
      'Update your persistent memory. `state` (optional) replaces the entire state object. `appendNote` (optional) appends a timestamped note. Pass either or both. Does not touch entries[]; use saveMemoryEntry for that.',
    inputSchema,
    async invoke({ state, appendNote }, ctx) {
      const existing: AgentMemory = (await db.agentMemory.get(ctx.agent.id)) ?? {
        agentId: ctx.agent.id,
        notes: '',
        state: {},
        updatedAt: Date.now(),
        entries: [],
      };
      const updatedState = state ?? existing.state;
      const updatedNotes = appendNote
        ? `${existing.notes}${existing.notes ? '\n' : ''}[${new Date().toISOString()}] ${appendNote}`
        : existing.notes;
      const updated: AgentMemory = {
        agentId: ctx.agent.id,
        state: updatedState,
        notes: updatedNotes,
        updatedAt: Date.now(),
        entries: existing.entries,
      };
      await db.agentMemory.upsert(updated);
      return { ok: true, stateKeys: Object.keys(updated.state).length, notesChars: updated.notes.length };
    },
  };
}
```

- [ ] **Step 3: `save-memory-entry-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import type { AgentMemory, MemoryEntry, MemoryEntryType } from '../../database/types';

const inputSchema = z.object({
  type: z.enum(['snapshot', 'observation', 'gist', 'note']).describe(
    'snapshot = full state at this tick, observation = something noticed, gist = summary of other entries, note = free-form.',
  ),
  content: z.string().min(1).describe('The entry payload — free text or JSON-as-string.'),
  parentEntryIds: z.array(z.string()).optional()
    .describe('IDs of entries this gist summarizes (only relevant when type=gist).'),
});

export function buildSaveMemoryEntryTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'saveMemoryEntry',
    description:
      'Append a new entry to your memory history. Use `snapshot` to capture state at end-of-tick, `observation` for noteworthy events, `gist` to summarize earlier entries, or `note` for free-form text.',
    inputSchema,
    async invoke({ type, content, parentEntryIds }, ctx) {
      const existing: AgentMemory = (await db.agentMemory.get(ctx.agent.id)) ?? {
        agentId: ctx.agent.id,
        notes: '',
        state: {},
        updatedAt: Date.now(),
        entries: [],
      };
      const entry: MemoryEntry = {
        id: `mem-${ctx.tickId}-${existing.entries.length}`,
        tickId: ctx.tickId,
        type: type as MemoryEntryType,
        content,
        ...(parentEntryIds && parentEntryIds.length > 0 ? { parentEntryIds } : {}),
        createdAt: Date.now(),
      };
      const updated: AgentMemory = {
        ...existing,
        entries: [...existing.entries, entry],
        updatedAt: Date.now(),
      };
      await db.agentMemory.upsert(updated);
      return { ok: true, entryId: entry.id, totalEntries: updated.entries.length };
    },
  };
}
```

- [ ] **Step 4: `search-memory-entries-tool.ts`**

```ts
import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';

const DEFAULT_LIMIT = 10;

const inputSchema = z.object({
  query: z.string().min(1).describe('Substring to look for (case-insensitive) inside entry content.'),
  type: z.enum(['snapshot', 'observation', 'gist', 'note']).optional()
    .describe('Optional filter to one entry type.'),
  limit: z.number().int().min(1).max(100).optional()
    .describe('Max results to return (default 10, newest first).'),
});

export function buildSearchMemoryEntriesTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'searchMemoryEntries',
    description:
      'Search your memory entries by case-insensitive substring match on content. Optional type filter. Returns the most recent matches first.',
    inputSchema,
    async invoke({ query, type, limit }, ctx) {
      const mem = await db.agentMemory.get(ctx.agent.id);
      if (!mem) return { matches: [] };
      const needle = query.toLowerCase();
      const max = limit ?? DEFAULT_LIMIT;
      const matches = mem.entries
        .filter((e) => (!type || e.type === type) && e.content.toLowerCase().includes(needle))
        .reverse()
        .slice(0, max);
      return { matches };
    },
  };
}
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: memory tool files compile.

- [ ] **Step 6: Commit**

```bash
git add src/ai-tools/memory/
git commit -m "feat(ai-tools): add memory tools (readMemory, updateMemory, saveMemoryEntry, searchMemoryEntries)"
```

---

## Task 12: `ToolRegistry` + tests

**Files:**
- Create: `src/ai-tools/tool-registry.ts`
- Create: `src/ai-tools/tool-registry.test.ts`
- Create: `src/ai-tools/tool-registry.live.test.ts`

- [ ] **Step 1: Implement `tool-registry.ts`**

```ts
import type { AgentTool } from './tool';
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
import type { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import type { SerperService } from '../providers/serper/serper-service';
import type { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { Database } from '../database/database';
import { buildCoingeckoPriceTool } from './providers/coingecko-price-tool';
import { buildCoinMarketCapInfoTool } from './providers/coinmarketcap-info-tool';
import { buildSerperSearchTool } from './providers/serper-search-tool';
import { buildFirecrawlScrapeTool } from './providers/firecrawl-scrape-tool';
import { buildWalletBalanceTools } from './wallet/wallet-balance-tools';
import { buildReadMemoryTool } from './memory/read-memory-tool';
import { buildUpdateMemoryTool } from './memory/update-memory-tool';
import { buildSaveMemoryEntryTool } from './memory/save-memory-entry-tool';
import { buildSearchMemoryEntriesTool } from './memory/search-memory-entries-tool';

export interface ToolRegistryDeps {
  coingecko: CoingeckoService;
  coinmarketcap: CoinMarketCapService;
  serper: SerperService;
  firecrawl: FirecrawlService;
  db: Database;
}

export class ToolRegistry {
  constructor(private readonly deps: ToolRegistryDeps) {}

  // All tools are stateless w.r.t. the agent — agent context flows in per-call
  // via AgentToolContext. The list itself can be reused across agents.
  build(): AgentTool[] {
    const [nativeBalance, tokenBalance] = buildWalletBalanceTools();
    return [
      buildCoingeckoPriceTool(this.deps.coingecko),
      buildCoinMarketCapInfoTool(this.deps.coinmarketcap),
      buildSerperSearchTool(this.deps.serper),
      buildFirecrawlScrapeTool(this.deps.firecrawl),
      nativeBalance,
      tokenBalance,
      buildReadMemoryTool(this.deps.db),
      buildUpdateMemoryTool(this.deps.db),
      buildSaveMemoryEntryTool(this.deps.db),
      buildSearchMemoryEntriesTool(this.deps.db),
    ];
  }
}
```

- [ ] **Step 2: Write the unit test (pure logic, no I/O)**

`src/ai-tools/tool-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { Database } from '../database/database';

// Pure-logic test: verifies the canonical tool list is what the LLM sees.
// No I/O — services and DB are constructed but never called.
describe('ToolRegistry.build', () => {
  it('returns the expected 10 tools in order', () => {
    const registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: 'unused' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: 'unused' }),
      serper: new SerperService({ apiKey: 'unused' }),
      firecrawl: new FirecrawlService({ apiKey: 'unused' }),
      db: {} as Database,
    });
    const names = registry.build().map((t) => t.name);
    expect(names).toEqual([
      'fetchTokenPriceUSD',
      'fetchTokenInfoBySymbol',
      'searchWeb',
      'scrapeUrlMarkdown',
      'getNativeBalance',
      'getTokenBalance',
      'readMemory',
      'updateMemory',
      'saveMemoryEntry',
      'searchMemoryEntries',
    ]);
  });

  it('every tool has a non-empty description and a zod input schema', () => {
    const registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: 'unused' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: 'unused' }),
      serper: new SerperService({ apiKey: 'unused' }),
      firecrawl: new FirecrawlService({ apiKey: 'unused' }),
      db: {} as Database,
    });
    for (const tool of registry.build()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema.parse).toBe('function');
    }
  });
});
```

- [ ] **Step 3: Write the live test (real I/O — provider, fs)**

`src/ai-tools/tool-registry.live.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from './tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import { FileDatabase } from '../database/file-database/file-database';
import { DryRunWallet } from '../wallet/dry-run/dry-run-wallet';
import { TOKENS } from '../constants';
import type { AgentConfig } from '../database/types';
import type { AgentToolContext } from './tool';

const TEST_KEY = '0x' + '11'.repeat(32);
const COINGECKO = process.env.COINGECKO_API_KEY;

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: id,
    enabled: true,
    intervalMs: 60_000,
    prompt: 'test',
    walletAddress: '',
    dryRun: true,
    dryRunSeedBalances: { native: '0', [TOKENS.USDC.address]: '5000000' },
    riskLimits: { maxTradeUSD: 100 },
    lastTickAt: null,
    createdAt: 0,
  };
}

describe('ToolRegistry tools (live, real services + fs)', () => {
  let dbDir: string;
  let registry: ToolRegistry;
  let agent: AgentConfig;
  let ctx: AgentToolContext;
  let db: FileDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-toolreg-'));
    db = new FileDatabase(dbDir);
    agent = makeAgent('a1');
    const wallet = new DryRunWallet(agent, db.transactions, { WALLET_PRIVATE_KEY: TEST_KEY });
    ctx = { agent, wallet, tickId: 'tick-test-1' };
    registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: COINGECKO ?? 'dummy' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: process.env.COINMARKETCAP_API_KEY ?? 'dummy' }),
      serper: new SerperService({ apiKey: process.env.SERPER_API_KEY ?? 'dummy' }),
      firecrawl: new FirecrawlService({ apiKey: process.env.FIRECRAWL_API_KEY ?? 'dummy' }),
      db,
    });
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it.skipIf(!COINGECKO)('fetchTokenPriceUSD returns a sensible UNI price', async () => {
    const tool = registry.build().find((t) => t.name === 'fetchTokenPriceUSD');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ symbol: 'UNI' }, ctx)) as { symbol: string; priceUSD: number };
    console.log('[tool-registry] price:', result);
    expect(result.symbol).toBe('UNI');
    expect(result.priceUSD).toBeGreaterThan(0);
  });

  it('getTokenBalance reflects the dry-run seed (USDC 5)', async () => {
    const tool = registry.build().find((t) => t.name === 'getTokenBalance');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ tokenAddress: TOKENS.USDC.address }, ctx)) as { tokenAddress: string; raw: string };
    console.log('[tool-registry] USDC balance:', result);
    expect(result.tokenAddress).toBe(TOKENS.USDC.address);
    expect(result.raw).toBe('5000000');
  });

  it('updateMemory persists state and notes for the right agent', async () => {
    const tool = registry.build().find((t) => t.name === 'updateMemory');
    if (!tool) throw new Error('tool missing');
    const result = (await tool.invoke({ state: { foo: 1 }, appendNote: 'hello' }, ctx)) as { ok: boolean };
    console.log('[tool-registry] updateMemory:', result);
    expect(result.ok).toBe(true);
    const mem = await db.agentMemory.get(agent.id);
    expect(mem?.state).toEqual({ foo: 1 });
    expect(mem?.notes).toContain('hello');
  });

  it('saveMemoryEntry appends an entry; searchMemoryEntries finds it', async () => {
    const save = registry.build().find((t) => t.name === 'saveMemoryEntry');
    const search = registry.build().find((t) => t.name === 'searchMemoryEntries');
    if (!save || !search) throw new Error('memory tools missing');

    await save.invoke({ type: 'observation', content: 'UNI rallied to 7.42 USD' }, ctx);
    await save.invoke({ type: 'note', content: 'will buy on the next dip' }, ctx);

    const matches = (await search.invoke({ query: 'UNI' }, ctx)) as { matches: Array<{ content: string }> };
    console.log('[tool-registry] search matches:', matches);
    expect(matches.matches).toHaveLength(1);
    expect(matches.matches[0]!.content).toContain('UNI');

    const all = (await search.invoke({ query: 'on the' }, ctx)) as { matches: Array<{ content: string }> };
    expect(all.matches).toHaveLength(1);
    expect(all.matches[0]!.content).toContain('dip');
  });

  it('readMemory returns state, notes, and recent entries', async () => {
    const update = registry.build().find((t) => t.name === 'updateMemory');
    const save = registry.build().find((t) => t.name === 'saveMemoryEntry');
    const read = registry.build().find((t) => t.name === 'readMemory');
    if (!update || !save || !read) throw new Error('memory tools missing');

    await update.invoke({ state: { lastPrice: 7.42 }, appendNote: 'rally' }, ctx);
    await save.invoke({ type: 'snapshot', content: 'price=7.42' }, ctx);

    const result = (await read.invoke({}, ctx)) as {
      state: Record<string, unknown>;
      notes: string;
      recentEntries: Array<{ content: string }>;
    };
    console.log('[tool-registry] read result:', result);
    expect(result.state).toEqual({ lastPrice: 7.42 });
    expect(result.notes).toContain('rally');
    expect(result.recentEntries).toHaveLength(1);
    expect(result.recentEntries[0]!.content).toBe('price=7.42');
  });
});
```

- [ ] **Step 4: Run both test files**

Run: `npx vitest run src/ai-tools/`
Expected:
- `tool-registry.test.ts`: 2 unit tests pass
- `tool-registry.live.test.ts`: 4 unconditional tests pass + 1 Coingecko-gated (passes if `COINGECKO_API_KEY` set, skips otherwise)

- [ ] **Step 5: Commit**

```bash
git add src/ai-tools/tool-registry.ts src/ai-tools/tool-registry.test.ts src/ai-tools/tool-registry.live.test.ts
git commit -m "feat(ai-tools): add ToolRegistry composing 10 tools + unit + live tests"
```

---

## Task 13: Rewrite `AgentRunner` to drive the tool loop

**Files:**
- Modify: `src/agent-runner/agent-runner.ts`

The runner now owns the loop. Per spec: pre-resolve `wallet`, `tools`, `memory`. Build initial messages from agent prompt + memory. Loop up to `maxToolRoundsPerTick`: call `llm.invokeWithTools`, log via `activityLog`, dispatch tools, append tool replies, repeat.

- [ ] **Step 1: Replace `src/agent-runner/agent-runner.ts` contents**

```ts
import type { Database } from '../database/database';
import type { AgentConfig, AgentMemory } from '../database/types';
import type { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import type { WalletFactory } from '../wallet/factory/wallet-factory';
import type { ToolRegistry } from '../ai-tools/tool-registry';
import type { AgentTool, AgentToolContext } from '../ai-tools/tool';
import { toToolDefinition } from '../ai-tools/zod-to-openai';
import { AGENT_RUNNER } from '../constants';
import type { ChatMessage, LLMClient, ToolCall } from './llm-client';

export interface Clock {
  now(): number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentRunner {
  constructor(
    private readonly db: Database,
    private readonly activityLog: AgentActivityLog,
    private readonly walletFactory: WalletFactory,
    private readonly llm: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async run(agent: AgentConfig): Promise<void> {
    const tickId = `${agent.id}-${this.clock.now()}`;

    try {
      await this.activityLog.tickStart(agent.id, tickId);

      const wallet = this.walletFactory.forAgent(agent);
      const tools = this.toolRegistry.build();
      const toolByName = new Map(tools.map((t) => [t.name, t]));
      const toolDefs = tools.map(toToolDefinition);

      const memory = await this.loadOrInitMemory(agent.id);
      const ctx: AgentToolContext = { agent, wallet, tickId };

      const messages: ChatMessage[] = [
        { role: 'system', content: this.buildSystemPrompt(agent, memory) },
        { role: 'user', content: 'Run one tick.' },
      ];

      let rounds = 0;
      while (rounds < AGENT_RUNNER.maxToolRoundsPerTick) {
        rounds++;
        const promptChars = messages.reduce((sum, m) => sum + this.messageChars(m), 0);
        await this.activityLog.llmCall(agent.id, tickId, {
          model: this.llm.modelName(),
          promptChars,
        });

        const turn = await this.llm.invokeWithTools(messages, toolDefs);

        await this.activityLog.llmResponse(agent.id, tickId, {
          model: this.llm.modelName(),
          responseChars: (turn.content ?? '').length,
          ...(turn.tokenCount !== undefined ? { tokenCount: turn.tokenCount } : {}),
        });

        messages.push(turn.assistantMessage);

        if (!turn.toolCalls || turn.toolCalls.length === 0) {
          // No more tool work — model is done.
          await this.activityLog.tickEnd(agent.id, tickId, {
            ok: true,
            rounds,
            responseChars: (turn.content ?? '').length,
          });
          return;
        }

        // Dispatch each tool call, collect tool reply messages.
        for (const call of turn.toolCalls) {
          const reply = await this.dispatchToolCall(agent.id, tickId, call, toolByName, ctx);
          messages.push(reply);
        }
      }

      // Hit the round cap without the model returning plain text.
      await this.activityLog.error(agent.id, tickId, {
        message: `exceeded ${AGENT_RUNNER.maxToolRoundsPerTick} tool-call rounds`,
      });
      await this.activityLog.tickEnd(agent.id, tickId, { ok: false, rounds });
    } catch (err) {
      const e = err as Error;
      try {
        await this.activityLog.error(agent.id, tickId, {
          message: e.message,
          stack: e.stack,
        });
        await this.activityLog.tickEnd(agent.id, tickId, { ok: false });
      } catch {
        // intentionally ignored — never rethrow
      }
    } finally {
      await this.db.agents.upsert({ ...agent, lastTickAt: this.clock.now() });
    }
  }

  private async dispatchToolCall(
    agentId: string,
    tickId: string,
    call: ToolCall,
    toolByName: Map<string, AgentTool>,
    ctx: AgentToolContext,
  ): Promise<ChatMessage> {
    const tool = toolByName.get(call.name);
    if (!tool) {
      const errMsg = `unknown tool: ${call.name}`;
      await this.activityLog.toolCall(agentId, tickId, { tool: call.name, input: call.argumentsJson });
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }

    let parsed: unknown;
    try {
      parsed = tool.inputSchema.parse(JSON.parse(call.argumentsJson));
    } catch (err) {
      const errMsg = `invalid tool input: ${(err as Error).message}`;
      await this.activityLog.toolCall(agentId, tickId, { tool: call.name, input: call.argumentsJson });
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }

    await this.activityLog.toolCall(agentId, tickId, { tool: call.name, input: parsed });
    const start = this.clock.now();
    try {
      const output = await tool.invoke(parsed, ctx);
      const durationMs = this.clock.now() - start;
      await this.activityLog.toolResult(agentId, tickId, {
        tool: call.name,
        output,
        durationMs,
      });
      return { role: 'tool', toolCallId: call.id, content: JSON.stringify(output) };
    } catch (err) {
      const errMsg = (err as Error).message;
      const durationMs = this.clock.now() - start;
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      await this.activityLog.toolResult(agentId, tickId, {
        tool: call.name,
        output: `error: ${errMsg}`,
        durationMs,
      });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }
  }

  private buildSystemPrompt(agent: AgentConfig, memory: AgentMemory): string {
    return [
      agent.prompt,
      '',
      'You have tools available — see the function-calling schema. Use them to gather information.',
      'Use saveMemoryEntry at the end of each tick to record what you learned and what you decided. Use updateMemory to overwrite your structured state when it changes.',
      '',
      'Current memory state:',
      JSON.stringify(memory.state, null, 2),
      '',
      'Current memory notes:',
      memory.notes || '(empty)',
      '',
      `Recent memory entries (last ${Math.min(5, memory.entries.length)}):`,
      memory.entries.length === 0
        ? '(none yet)'
        : JSON.stringify(memory.entries.slice(-5), null, 2),
    ].join('\n');
  }

  private async loadOrInitMemory(agentId: string): Promise<AgentMemory> {
    const existing = await this.db.agentMemory.get(agentId);
    if (existing) return existing;
    return {
      agentId,
      notes: '',
      state: {},
      updatedAt: this.clock.now(),
      entries: [],
    };
  }

  private messageChars(m: ChatMessage): number {
    if (m.role === 'tool') return m.content.length;
    if (m.role === 'assistant') return m.content.length;
    return m.content.length;
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: typecheck FAILS only in `agent-runner.live.test.ts` (Task 14 fixes it) and `src/index.ts` (Task 15 fixes it).

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/agent-runner.ts
git commit -m "feat(agent-runner): orchestrate tool loop using LLMClient.invokeWithTools + ToolRegistry"
```

---

## Task 14: Rewrite `agent-runner.live.test.ts`

**Files:**
- Modify: `src/agent-runner/agent-runner.live.test.ts`

Uses a `ScriptedLLMClient` that implements our (small) `LLMClient` interface — no Langchain stub plumbing. Tests cover: text-only response, tool-call then text, error path, round-cap.

- [ ] **Step 1: Replace the file**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDatabase } from '../database/file-database/file-database';
import { FileActivityLogStore } from '../agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import { WalletFactory } from '../wallet/factory/wallet-factory';
import { ToolRegistry } from '../ai-tools/tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import { AgentRunner, type Clock } from './agent-runner';
import type {
  ChatMessage,
  LLMClient,
  LLMResponse,
  LLMTurnResult,
  ToolDefinition,
} from './llm-client';
import type { AgentConfig } from '../database/types';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = { WALLET_PRIVATE_KEY: TEST_KEY, ALCHEMY_API_KEY: 'unused' };

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: `agent-${id}`,
    enabled: true,
    intervalMs: 60_000,
    prompt: `You are ${id}. Respond briefly.`,
    walletAddress: '',
    dryRun: true,
    dryRunSeedBalances: { native: '1000000000000000000' },
    riskLimits: { maxTradeUSD: 100 },
    lastTickAt: null,
    createdAt: 1000,
  };
}

// Minimal scripted client. Each call to invokeWithTools consumes one step.
type ScriptStep =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; toolName: string; argsJson: string }
  | { kind: 'throw'; message: string };

class ScriptedLLMClient implements LLMClient {
  private readonly script: ScriptStep[];
  private callCount = 0;

  constructor(script: ScriptStep[]) {
    this.script = [...script];
  }

  modelName(): string {
    return 'scripted';
  }

  async invoke(prompt: string): Promise<LLMResponse> {
    return { content: `[scripted] ${prompt.slice(0, 40)}` };
  }

  async invokeWithTools(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<LLMTurnResult> {
    this.callCount++;
    const step = this.script.shift();
    if (!step) throw new Error('ScriptedLLMClient: script exhausted at call ' + this.callCount);

    if (step.kind === 'throw') throw new Error(step.message);

    if (step.kind === 'tool') {
      const id = `call-${this.callCount}`;
      return {
        toolCalls: [{ id, name: step.toolName, argumentsJson: step.argsJson }],
        assistantMessage: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id, name: step.toolName, argumentsJson: step.argsJson }],
        },
      };
    }

    return {
      content: step.content,
      assistantMessage: { role: 'assistant', content: step.content },
    };
  }
}

describe('AgentRunner (live, real db + activity log + ToolRegistry)', () => {
  let dbDir: string;
  let db: FileDatabase;
  let activityLog: AgentActivityLog;
  let walletFactory: WalletFactory;
  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-runner-'));
    db = new FileDatabase(dbDir);
    activityLog = new AgentActivityLog(new FileActivityLogStore(dbDir));
    walletFactory = new WalletFactory(TEST_ENV, db.transactions);
    toolRegistry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: 'dummy' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: 'dummy' }),
      serper: new SerperService({ apiKey: 'dummy' }),
      firecrawl: new FirecrawlService({ apiKey: 'dummy' }),
      db,
    });
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('writes tick_start, llm_call, llm_response, tick_end and updates lastTickAt (no tool calls)', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);
    const fixedClock: Clock = { now: () => 5_000 };
    const llm = new ScriptedLLMClient([{ kind: 'text', content: 'hello there' }]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry, fixedClock);

    await runner.run(agent);

    const types = (await activityLog.list('a1')).map((e) => e.type);
    console.log('[runner] entries:', types);
    expect(types[0]).toBe('tick_start');
    expect(types).toContain('llm_call');
    expect(types).toContain('llm_response');
    expect(types[types.length - 1]).toBe('tick_end');

    const reloaded = await db.agents.findById('a1');
    expect(reloaded?.lastTickAt).toBe(5_000);
  });

  it('captures tool_call + tool_result entries when the model emits a tool call', async () => {
    const agent = makeAgent('a-tools');
    await db.agents.upsert(agent);

    const llm = new ScriptedLLMClient([
      { kind: 'tool', toolName: 'updateMemory', argsJson: JSON.stringify({ appendNote: 'first thought' }) },
      { kind: 'text', content: 'done' },
    ]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

    await runner.run(agent);

    const types = (await activityLog.list('a-tools')).map((e) => e.type);
    console.log('[runner] tool-loop entries:', types);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('tick_end');

    const mem = await db.agentMemory.get('a-tools');
    expect(mem?.notes).toContain('first thought');
  });

  it('does not rethrow when the LLM throws, and still updates lastTickAt + writes error entry', async () => {
    const agent = makeAgent('boom');
    await db.agents.upsert(agent);
    const fixedClock: Clock = { now: () => 9_000 };

    const llm = new ScriptedLLMClient([{ kind: 'throw', message: 'llm exploded' }]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry, fixedClock);
    await expect(runner.run(agent)).resolves.toBeUndefined();

    const types = (await activityLog.list('boom')).map((e) => e.type);
    console.log('[runner] error path:', types);
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('tick_end');

    const reloaded = await db.agents.findById('boom');
    expect(reloaded?.lastTickAt).toBe(9_000);
  });

  it('returns a tool-error message (not a thrown rejection) when a tool throws', async () => {
    const agent = makeAgent('tool-bad');
    await db.agents.upsert(agent);

    // Bad tokenAddress triggers the wallet-balance tool to throw.
    const llm = new ScriptedLLMClient([
      { kind: 'tool', toolName: 'getTokenBalance', argsJson: JSON.stringify({ tokenAddress: 'not-an-address' }) },
      { kind: 'text', content: 'recovered' },
    ]);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

    await runner.run(agent);

    const entries = await activityLog.list('tool-bad');
    const types = entries.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('error');
    expect(types[types.length - 1]).toBe('tick_end');

    const toolResult = entries.find((e) => e.type === 'tool_result');
    console.log('[runner] tool error result:', toolResult?.payload);
    expect(String(toolResult?.payload.output)).toContain('error:');
  });

  it('caps the loop at maxToolRoundsPerTick when the model only returns tool calls', async () => {
    const agent = makeAgent('runaway');
    await db.agents.upsert(agent);

    // Always return a tool call — never plain text. Provide 12 steps so we
    // hit the cap of 10 first.
    const stepsCount = 12;
    const script = Array.from({ length: stepsCount }, () => ({
      kind: 'tool' as const,
      toolName: 'readMemory',
      argsJson: '{}',
    }));
    const llm = new ScriptedLLMClient(script);
    const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

    await runner.run(agent);

    const entries = await activityLog.list('runaway');
    const errorEntry = entries.find((e) => e.type === 'error');
    expect(errorEntry?.payload.message).toMatch(/exceeded \d+ tool-call rounds/);
    expect(entries[entries.length - 1]?.type).toBe('tick_end');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/agent-runner/`
Expected: 5 tests pass; tool-loop entries logged.

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/agent-runner.live.test.ts
git commit -m "feat(agent-runner): rewrite live test with ScriptedLLMClient covering tool loop + cap + error path"
```

---

## Task 15: Wire `ToolRegistry` into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace contents**

```ts
import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';
import { AgentOrchestrator } from './agent-looper/agent-orchestrator';
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { StubLLMClient } from './agent-runner/stub-llm-client';
import type { LLMClient } from './agent-runner/llm-client';
import { ZeroGBootstrapStore } from './ai/zerog-broker/zerog-bootstrap-store';
import { buildZeroGBroker } from './ai/zerog-broker/zerog-broker-factory';
import { ZeroGLLMClient } from './ai/chat-model/zerog-llm-client';
import { ToolRegistry } from './ai-tools/tool-registry';
import { CoingeckoService } from './providers/coingecko/coingecko-service';
import { CoinMarketCapService } from './providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from './providers/serper/serper-service';
import { FirecrawlService } from './providers/firecrawl/firecrawl-service';

async function buildLLM(env: Env): Promise<LLMClient> {
  const store = new ZeroGBootstrapStore(env.DB_DIR);
  const state = await store.load();
  if (!state) {
    console.log('[bootstrap] no zerog-bootstrap.json; using StubLLMClient. Run `npm run zerog-bootstrap` to fund a 0G provider.');
    return new StubLLMClient();
  }
  if (state.network !== env.ZEROG_NETWORK) {
    console.warn(
      `[bootstrap] WARNING: zerog-bootstrap.json was funded on '${state.network}' but env says '${env.ZEROG_NETWORK}'; using the file's network. Delete db/zerog-bootstrap.json and re-run \`npm run zerog-bootstrap\` to switch.`,
    );
  }
  const { broker } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: state.network,
  });
  console.log(`[bootstrap] 0G LLM ready — network=${state.network} provider=${state.providerAddress} model=${state.model}`);
  return new ZeroGLLMClient({
    broker,
    providerAddress: state.providerAddress,
    serviceUrl: state.serviceUrl,
    model: state.model,
  });
}

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }

  const db = new FileDatabase(env.DB_DIR);
  const activityLog = new AgentActivityLog(new FileActivityLogStore(env.DB_DIR));
  const walletFactory = new WalletFactory(env, db.transactions);
  const llm = await buildLLM(env);

  const toolRegistry = new ToolRegistry({
    coingecko: new CoingeckoService({ apiKey: env.COINGECKO_API_KEY }),
    coinmarketcap: new CoinMarketCapService({ apiKey: env.COINMARKETCAP_API_KEY }),
    serper: new SerperService({ apiKey: env.SERPER_API_KEY }),
    firecrawl: new FirecrawlService({ apiKey: env.FIRECRAWL_API_KEY }),
    db,
  });

  const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);
  const orchestrator = new AgentOrchestrator(db, runner);

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);
  console.log(`[bootstrap] wallet factory initialized`);
  console.log(`[bootstrap] tool registry initialized (${toolRegistry.build().length} tools)`);
  console.log(`[bootstrap] agent runner initialized (LLM: ${llm.modelName()})`);

  const looper = new Looper({
    tickIntervalMs: LOOPER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(
        `[looper] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`,
      );
      await orchestrator.tick();
    },
  });

  looper.start();
  console.log(`[bootstrap] looper started, ticking every ${LOOPER.tickIntervalMs}ms`);

  const shutdown = (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping looper`);
    looper.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0. (All slice 6 cuts have landed.)

- [ ] **Step 3: Smoke (no bootstrap.json — stub LLM, no tool calls expected)**

```bash
rm -f ./db/zerog-bootstrap.json
WALLET_PRIVATE_KEY=0x$(printf '11%.0s' {1..32}) npm start &
PID=$!
sleep 12
kill $PID 2>/dev/null
wait $PID 2>/dev/null
```

Expected output (key lines):
```
[bootstrap] no zerog-bootstrap.json; using StubLLMClient. ...
[bootstrap] env loaded — ZEROG_NETWORK=mainnet, DB_DIR=./db
[bootstrap] database + activity log initialized at ./db
[bootstrap] wallet factory initialized
[bootstrap] tool registry initialized (10 tools)
[bootstrap] agent runner initialized (LLM: stub)
[bootstrap] looper started, ticking every 10000ms
[looper] tick @ 2026-04-27T...Z — 0 agent(s) loaded
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire ToolRegistry into bootstrap and pass to AgentRunner"
```

---

## Task 16: Full sweep + tag

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected:
- `tool-registry.test.ts` — 2 unit tests pass
- `tool-registry.live.test.ts` — 4 unconditional pass + 1 Coingecko-gated
- `agent-runner.live.test.ts` — 5 pass (rewritten)
- All slice 1–5 suites pass / skip as before
- Only known failure: pre-existing Firecrawl 402

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: exit 0; `dist/ai-tools/` populated; `dist/agent-runner/` reflects updated structure.

- [ ] **Step 3: Verify directory structure**

Run: `find src -type f -name '*.ts' | sort`

Expected new files (versus slice 5):
```
src/agent-runner/agent-runner.live.test.ts   # rewritten
src/agent-runner/agent-runner.ts             # rewritten
src/agent-runner/llm-client.ts               # extended
src/agent-runner/stub-llm-client.ts          # extended
src/ai-tools/memory/read-memory-tool.ts
src/ai-tools/memory/save-memory-entry-tool.ts
src/ai-tools/memory/search-memory-entries-tool.ts
src/ai-tools/memory/update-memory-tool.ts
src/ai-tools/providers/coingecko-price-tool.ts
src/ai-tools/providers/coinmarketcap-info-tool.ts
src/ai-tools/providers/firecrawl-scrape-tool.ts
src/ai-tools/providers/serper-search-tool.ts
src/ai-tools/tool-registry.live.test.ts
src/ai-tools/tool-registry.test.ts
src/ai-tools/tool-registry.ts
src/ai-tools/tool.ts
src/ai-tools/wallet/wallet-balance-tools.ts
src/ai-tools/zod-to-openai.ts
src/ai/chat-model/zerog-llm-client.ts        # extended
src/constants/agent-runner.ts
src/constants/index.ts                       # extended
src/constants/tokens.ts                      # extended
src/database/file-database/file-agent-memory-repository.ts  # extended
src/database/types.ts                        # extended
src/index.ts                                 # extended
```

- [ ] **Step 4: Tag**

```bash
git tag slice-6-tools
```

- [ ] **Step 5: Commit count**

Run: `git log --oneline slice-5-zerog-llm..HEAD`
Expected: ~17 commits (Tasks 1–15 + the docs/plan commit).

---

## Out of Scope for Slice 6

Deferred to later slices:
- Uniswap quote/swap tools — Slice 7
- Risk-limit (`maxTradeUSD`) enforcement at the swap tool wrapper — Slice 7
- Position open/close + transaction recording on swap — Slice 7
- Seed agent end-to-end — Slice 8
- Embedding-based memory similarity search — Slice 9+ (the `embedding?: number[]` field is structurally present; only `searchMemoryEntries` impl needs swapping)
- Auto-snapshot of `state` every N ticks — never (the LLM calls `saveMemoryEntry` itself; if it doesn't behave we'll add a hook)
- Per-agent tool allowlist — never for v1 (all-tools-on)
- Streaming responses — never for v1
- Parallel tool dispatch within one assistant message — sequential is enough for v1

---

## Self-Review

**Spec coverage check:**
- ✅ "Tools" section — `ai-tools/` with `ToolRegistry` composing wrappers; zod schemas converted to OpenAI function format — Tasks 8, 9, 10, 11, 12
- ✅ Initial tool surface (Coingecko, CMC, Serper, Firecrawl, wallet balance) — Tasks 9, 10
- ✅ Memory-update tool surface (replace state, append note) plus read/save-entry/search per locked decision — Task 11
- ✅ All-tools-on for v1 (no per-agent allowlist) — Task 12
- ✅ Tools that need agent context get it via `AgentToolContext` injected per-call — Tasks 8, 13
- ✅ Risk-enforcement at the tool wrapper — N/A this slice (slice 7 swap tool)
- ✅ Comprehensive logging via `AgentActivityLog` — Task 13 (`dispatchToolCall` writes `tool_call`, `tool_result`, `error`)
- ✅ Per-tick context (agent.id, tickId) directly in scope inside the loop — Task 13 (no callback bridge needed)
- ✅ MAX_TOOL_ROUNDS in constants — Task 1, consumed in Task 13
- ✅ Tool errors return as tool message + log to activity log — Task 13's `dispatchToolCall`

**Placeholder scan:** No TBDs, no "implement later". Every step has actual code or an exact command.

**Type consistency:**
- `LLMClient` defined Task 5, implemented in Tasks 6 (`ZeroGLLMClient.invokeWithTools`) + 7 (`StubLLMClient.invokeWithTools`), consumed in Task 13 (`AgentRunner`)
- `ChatMessage` / `ToolCall` / `ToolDefinition` / `LLMTurnResult` defined Task 5, used Tasks 6, 13
- `AgentTool<TInput>` defined Task 8, returned by every `build...Tool` in Tasks 9–11
- `AgentToolContext` defined Task 8, populated in Task 13's `run()` with `{ agent, wallet, tickId }`
- `ToolRegistry.build(): AgentTool[]` (Task 12) consumed by Task 13's `AgentRunner.run`
- `MemoryEntry` / `MemoryEntryType` defined Task 3, used in Task 11's save/search tools
- `AGENT_RUNNER.maxToolRoundsPerTick` defined Task 1, consumed Task 13's loop
- `Clock` interface unchanged from slice 4
- `ScriptedLLMClient` (test, Task 14) implements the same `LLMClient` interface from Task 5 — no special test plumbing needed
