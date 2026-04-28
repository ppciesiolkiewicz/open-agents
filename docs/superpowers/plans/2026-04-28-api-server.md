# API Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Express HTTP server (same Node process as the Looper) that exposes agent CRUD, start/stop, paginated activity log, and chat-mode SSE ticks; publish an OpenAPI 3.1 spec for FE SDK generation.

**Architecture:** Reuse `AgentRunner` core loop via a `TickStrategy` split (scheduled vs chat). Reuse the activity log as the chat transcript store via a new `user_message` event type plus a pure `chat-history-projection` function. Stream chat ticks over SSE using a new optional `onToken` callback on `LLMClient`. Auth is a middleware shim with a stub user, ready for JWT.

**Tech Stack:** TypeScript, Express 4, `cors`, `zod`, `@asteasolutions/zod-to-openapi`, `swagger-ui-express`, OpenAI SDK (existing), Node 20+, vitest.

**Spec:** [docs/superpowers/specs/2026-04-28-api-server-design.md](../specs/2026-04-28-api-server-design.md)

---

## Post-implementation deviations from the original task code blocks

Phases 1–2 landed the structures described below, then five cleanups changed the contracts. **Read this section before reading individual task code blocks — the snippets below this line are out of date in these specific ways.** The shipped code at `HEAD` is the source of truth.

1. **`AgentConfig.type` is required, not defaulted.** `FileAgentRepository.readFile` does NOT inject `type: 'scheduled'` for missing rows. DBs must carry `type` on every row; pre-existing rows need a manual migration or DB reset.
2. **`TickStrategy.buildInitialMessages` returns `Promise<ChatMessage[]>` directly.** The `TickStrategyResult { userMessageContent; initialMessages }` shape was dropped. Strategies are now responsible for any preamble logging they want.
3. **`TickStrategyContext` carries `tickId: string`** so strategies can write activity-log events scoped to the current tick.
4. **`ScheduledTickStrategy` returns `[{role:'system', content: systemPrompt}]`** — no synthetic `{role:'user', content:'Run one tick.'}` and no `user_message` activity event. System prompt is the directive.
5. **`ChatTickStrategy` writes `user_message` itself** at the top of `buildInitialMessages` (before reading history) using `ctx.tickId`. `AgentRunner` no longer emits `user_message` from its own code path.
6. **`AGENT_RUNNER.chatHistoryLimit`** in `src/constants/` replaces the module-local `HISTORY_LIMIT = 200`.
7. **`InvokeOptions` carries `onToken`, `onToolCall`, `onToolResult`.** `AgentRunner.dispatchToolCall` accepts `options` as a final parameter and invokes the callbacks alongside its existing activity-log writes (success and error paths). The Phase 5 SSE route forwards each callback as a `tool_call` / `tool_result` SSE event — Task 21's "deferred tool events" note is obsolete.
8. **Streaming `tokenCount`** is captured via `stream_options: { include_usage: true }` on the OpenAI request and read from the final chunk's `chunk.usage.total_tokens`. Activity-log `llm_response` events for chat ticks now carry token counts identically to scheduled ticks.

---

## File Structure

**New modules:**
- `src/api-server/server.ts` — `ApiServer` class wires routes, returns Express app + `start()/stop()`
- `src/api-server/routes/agents.ts` — CRUD + start/stop
- `src/api-server/routes/activity.ts` — paginated activity log
- `src/api-server/routes/messages.ts` — paginated chat history (GET) + SSE chat tick (POST)
- `src/api-server/routes/openapi.ts` — `/openapi.json` + `/docs`
- `src/api-server/middleware/auth.ts` — `authMiddleware` + `assertAgentOwnedBy`
- `src/api-server/middleware/error-handler.ts` — domain → HTTP mapping, zod errors → 400
- `src/api-server/middleware/cors.ts` — CORS config from env
- `src/api-server/sse/event-stream.ts` — SSE writer wrapper
- `src/api-server/pagination/cursor.ts` — opaque cursor encode/decode
- `src/api-server/openapi/spec-builder.ts` — composes zod schemas into OpenAPI document
- `src/api-server/openapi/schemas.ts` — request/response zod schemas + OpenAPI registry
- `src/agent-runner/tick-strategies/tick-strategy.ts` — `TickStrategy` interface
- `src/agent-runner/tick-strategies/scheduled-tick-strategy.ts` — current behavior
- `src/agent-runner/tick-strategies/chat-tick-strategy.ts` — replays log + appends user msg
- `src/agent-runner/tick-strategies/chat-history-projection.ts` — activity events → ChatMessage[] + ChatMessageView[]

**Modified:**
- `src/database/types.ts` — `AgentConfig` adds `type` discriminator + chat-only fields
- `src/database/repositories/agent-repository.ts` — adds `delete(id)` + `findById` already returns null
- `src/database/file-database/file-agent-repository.ts` — implements `delete`, defaults missing `type` on read
- `src/agent-activity-log/types.ts` — adds `'user_message'` to `AgentActivityLogEntryType`
- `src/agent-activity-log/agent-activity-log.ts` — adds `userMessage()` method + `id` field on `toolCall`/`toolResult`/`llmResponse` tool-call rows
- `src/agent-runner/agent-runner.ts` — refactored to take a `TickStrategy`; logs `user_message` via strategy
- `src/agent-runner/llm-client.ts` — `InvokeOptions { onToken?, signal? }` on `invokeWithTools`
- `src/agent-runner/stub-llm-client.ts` — invokes `onToken` once with canned content
- `src/ai/chat-model/zerog-llm-client.ts` — streaming path when `onToken` set
- `src/agent-looper/agent-orchestrator.ts` — filters `agent.type !== 'chat'`
- `src/config/env.ts` — adds `PORT`, `API_CORS_ORIGINS`
- `src/index.ts` — boots `ApiServer` after Looper
- `package.json` — adds runtime deps

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime deps**

```bash
npm install express cors swagger-ui-express @asteasolutions/zod-to-openapi
npm install -D @types/express @types/cors @types/swagger-ui-express
```

- [ ] **Step 2: Verify install + typecheck**

```bash
npm run typecheck
```

Expected: PASS (no new code yet, just deps).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add express + cors + swagger-ui-express + zod-to-openapi"
```

---

## Task 2: AgentConfig adds `type` discriminator

**Files:**
- Modify: `src/database/types.ts`
- Modify: `src/database/file-database/file-agent-repository.ts`

- [ ] **Step 1: Add `type` and chat-only fields to `AgentConfig`**

Replace the `AgentConfig` interface in `src/database/types.ts` with:

```ts
export type AgentType = 'scheduled' | 'chat';

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  enabled: boolean;
  intervalMs: number;
  prompt: string;
  walletAddress: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>;
  riskLimits: {
    maxTradeUSD: number;
    maxSlippageBps: number;
    [k: string]: unknown;
  };
  lastTickAt: number | null;
  lastMessageAt?: number | null;
  createdAt: number;
}
```

`enabled` and `intervalMs` stay required (chat agents will set `enabled: false`, `intervalMs: 0` — orchestrator filters them out by `type` anyway, so the values are ignored).

- [ ] **Step 2: Default `type` on read in `FileAgentRepository`**

In `src/database/file-database/file-agent-repository.ts`, after `JSON.parse(raw)`, normalize each agent:

```ts
private async readFile(): Promise<DatabaseFile> {
  try {
    const raw = await readFile(this.path, 'utf8');
    const parsed = JSON.parse(raw) as DatabaseFile;
    parsed.agents = parsed.agents.map((a) => ({ ...a, type: a.type ?? 'scheduled' }));
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { agents: [], transactions: [], positions: [] };
    }
    throw err;
  }
}
```

- [ ] **Step 3: Update `buildSeedAgentConfig` to set `type`**

In `scripts/lib/seed-uni-ma-trader.ts`, ensure the returned config sets `type: 'scheduled'`. Find the returned object literal and add the field.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If the seed-agent helper or other call sites construct `AgentConfig` without `type`, fix each.

- [ ] **Step 5: Commit**

```bash
git add src/database/types.ts src/database/file-database/file-agent-repository.ts scripts/lib/seed-uni-ma-trader.ts
git commit -m "feat(database): add type discriminator to AgentConfig (scheduled|chat)"
```

---

## Task 3: AgentRepository gains `delete`

**Files:**
- Modify: `src/database/repositories/agent-repository.ts`
- Modify: `src/database/file-database/file-agent-repository.ts`

- [ ] **Step 1: Add `delete` to interface**

```ts
export interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  findById(id: string): Promise<AgentConfig | null>;
  upsert(agent: AgentConfig): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- [ ] **Step 2: Implement `delete` in FileAgentRepository**

Add to `src/database/file-database/file-agent-repository.ts`:

```ts
async delete(id: string): Promise<void> {
  const file = await this.readFile();
  const before = file.agents.length;
  file.agents = file.agents.filter((a) => a.id !== id);
  if (file.agents.length === before) return; // not found = noop
  await this.writeFile(file);
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/database/repositories/agent-repository.ts src/database/file-database/file-agent-repository.ts
git commit -m "feat(database): add AgentRepository.delete"
```

---

## Task 4: Activity log — add `id` to tool-call payloads

Why: chat-history projection needs the OpenAI tool-call `id` to match `tool_call` events with their `tool_result` events when reconstructing `messages[]`.

**Files:**
- Modify: `src/agent-activity-log/agent-activity-log.ts`
- Modify: `src/agent-runner/agent-runner.ts`

- [ ] **Step 1: Extend payload signatures**

In `src/agent-activity-log/agent-activity-log.ts`:

```ts
toolCall(
  agentId: string,
  tickId: string,
  payload: { id: string; tool: string; input: unknown },
): Promise<void> {
  return this.write(agentId, tickId, 'tool_call', payload);
}

toolResult(
  agentId: string,
  tickId: string,
  payload: { id: string; tool: string; output: unknown; durationMs: number },
): Promise<void> {
  return this.write(agentId, tickId, 'tool_result', payload);
}

llmResponse(
  agentId: string,
  tickId: string,
  payload: {
    model: string;
    responseChars: number;
    tokenCount?: number;
    content: string;
    toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  },
): Promise<void> {
  return this.write(agentId, tickId, 'llm_response', payload);
}
```

- [ ] **Step 2: Update AgentRunner call sites to pass `id`**

In `src/agent-runner/agent-runner.ts`, find the three call sites and pass through `call.id`:

```ts
await this.activityLog.llmResponse(agent.id, tickId, {
  model: this.llm.modelName(),
  responseChars: (turn.content ?? '').length,
  ...(turn.tokenCount !== undefined ? { tokenCount: turn.tokenCount } : {}),
  content: turn.content ?? '',
  ...(turn.toolCalls && turn.toolCalls.length > 0
    ? {
        toolCalls: turn.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          argumentsJson: c.argumentsJson,
        })),
      }
    : {}),
});
```

In `dispatchToolCall`, both `activityLog.toolCall(...)` and `activityLog.toolResult(...)` calls take `id: call.id` and `id: call.id` respectively.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/agent-activity-log/agent-activity-log.ts src/agent-runner/agent-runner.ts
git commit -m "feat(activity-log): include OpenAI tool_call id in toolCall/toolResult/llmResponse payloads"
```

---

## Task 5: Activity log — add `user_message` event

**Files:**
- Modify: `src/agent-activity-log/types.ts`
- Modify: `src/agent-activity-log/agent-activity-log.ts`

- [ ] **Step 1: Extend the entry type union**

In `src/agent-activity-log/types.ts`:

```ts
export type AgentActivityLogEntryType =
  | 'user_message'
  | 'tick_start'
  | 'tick_end'
  | 'tool_call'
  | 'tool_result'
  | 'llm_call'
  | 'llm_response'
  | 'memory_update'
  | 'error';
```

- [ ] **Step 2: Add `userMessage` writer**

In `src/agent-activity-log/agent-activity-log.ts` (after `tickEnd`):

```ts
userMessage(
  agentId: string,
  tickId: string,
  payload: { content: string },
): Promise<void> {
  return this.write(agentId, tickId, 'user_message', payload);
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/agent-activity-log/types.ts src/agent-activity-log/agent-activity-log.ts
git commit -m "feat(activity-log): add user_message event type"
```

---

## Task 6: TickStrategy interface + ScheduledTickStrategy

**Files:**
- Create: `src/agent-runner/tick-strategies/tick-strategy.ts`
- Create: `src/agent-runner/tick-strategies/scheduled-tick-strategy.ts`

- [ ] **Step 1: Create `TickStrategy` interface**

`src/agent-runner/tick-strategies/tick-strategy.ts`:

```ts
import type { AgentConfig, AgentMemory } from '../../database/types';
import type { ChatMessage } from '../llm-client';

export interface TickStrategyContext {
  agent: AgentConfig;
  memory: AgentMemory;
  systemPrompt: string;
}

export interface TickStrategyResult {
  userMessageContent: string;
  initialMessages: ChatMessage[];
}

export interface TickStrategy {
  buildInitialMessages(ctx: TickStrategyContext): Promise<TickStrategyResult>;
}
```

- [ ] **Step 2: Create `ScheduledTickStrategy`**

`src/agent-runner/tick-strategies/scheduled-tick-strategy.ts`:

```ts
import type { ChatMessage } from '../llm-client';
import type { TickStrategy, TickStrategyContext, TickStrategyResult } from './tick-strategy';

const SCHEDULED_USER_MESSAGE = 'Run one tick.';

export class ScheduledTickStrategy implements TickStrategy {
  async buildInitialMessages(ctx: TickStrategyContext): Promise<TickStrategyResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'user', content: SCHEDULED_USER_MESSAGE },
    ];
    return {
      userMessageContent: SCHEDULED_USER_MESSAGE,
      initialMessages: messages,
    };
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/agent-runner/tick-strategies/
git commit -m "feat(agent-runner): add TickStrategy interface + ScheduledTickStrategy"
```

---

## Task 7: Refactor AgentRunner to take a `TickStrategy`

**Files:**
- Modify: `src/agent-runner/agent-runner.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Refactor `AgentRunner.run` signature**

Replace the current run implementation in `src/agent-runner/agent-runner.ts`. The class accepts a default strategy in its constructor; `run` accepts an optional override (chat ticks pass `ChatTickStrategy`).

```ts
import type { TickStrategy } from './tick-strategies/tick-strategy';
import { ScheduledTickStrategy } from './tick-strategies/scheduled-tick-strategy';

export class AgentRunner {
  private readonly defaultStrategy: TickStrategy;

  constructor(
    private readonly db: Database,
    private readonly activityLog: AgentActivityLog,
    private readonly walletFactory: WalletFactory,
    private readonly llm: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly clock: Clock = SYSTEM_CLOCK,
    defaultStrategy: TickStrategy = new ScheduledTickStrategy(),
  ) {
    this.defaultStrategy = defaultStrategy;
  }

  async run(agent: AgentConfig, strategy: TickStrategy = this.defaultStrategy, options: { onToken?: (text: string) => void } = {}): Promise<void> {
    const tickId = `${agent.id}-${this.clock.now()}`;
    try {
      const memory = await this.loadOrInitMemory(agent.id);
      const systemPrompt = this.buildSystemPrompt(agent, memory);
      const { userMessageContent, initialMessages } = await strategy.buildInitialMessages({
        agent,
        memory,
        systemPrompt,
      });

      await this.activityLog.userMessage(agent.id, tickId, { content: userMessageContent });
      await this.activityLog.tickStart(agent.id, tickId);
      this.logStdout(agent.id, `tick start (tickId=${tickId})`);

      const wallet = this.walletFactory.forAgent(agent);
      const tools = this.toolRegistry.build();
      const toolByName = new Map(tools.map((t) => [t.name, t]));
      const toolDefs = tools.map(toToolDefinition);
      const ctx: AgentToolContext = { agent, wallet, tickId };

      await this.runToolLoop(agent, tickId, initialMessages, toolDefs, toolByName, ctx, options);
    } catch (err) {
      const e = err as Error;
      this.logStdout(agent.id, `ERROR ${e.message}`);
      try {
        await this.activityLog.error(agent.id, tickId, { message: e.message, stack: e.stack });
        await this.activityLog.tickEnd(agent.id, tickId, { ok: false });
      } catch {
        // ignore
      }
      throw err;
    } finally {
      await this.db.agents.upsert({ ...agent, lastTickAt: this.clock.now() });
    }
  }

  private async runToolLoop(
    agent: AgentConfig,
    tickId: string,
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    toolByName: Map<string, AgentTool>,
    ctx: AgentToolContext,
    options: { onToken?: (text: string) => void },
  ): Promise<void> {
    let rounds = 0;
    while (rounds < AGENT_RUNNER.maxToolRoundsPerTick) {
      rounds++;
      const promptChars = messages.reduce((sum, m) => {
        let chars = m.content.length;
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          chars += JSON.stringify(m.toolCalls).length;
        }
        return sum + chars;
      }, 0);
      await this.activityLog.llmCall(agent.id, tickId, { model: this.llm.modelName(), promptChars });
      this.logStdout(agent.id, `llm_call round=${rounds} model=${this.llm.modelName()} promptChars=${promptChars}`);

      const turn = await this.llm.invokeWithTools(messages, toolDefs, options.onToken ? { onToken: options.onToken } : undefined);

      await this.activityLog.llmResponse(agent.id, tickId, {
        model: this.llm.modelName(),
        responseChars: (turn.content ?? '').length,
        ...(turn.tokenCount !== undefined ? { tokenCount: turn.tokenCount } : {}),
        content: turn.content ?? '',
        ...(turn.toolCalls && turn.toolCalls.length > 0
          ? {
              toolCalls: turn.toolCalls.map((c) => ({
                id: c.id,
                name: c.name,
                argumentsJson: c.argumentsJson,
              })),
            }
          : {}),
      });

      const reasoning = (turn.content ?? '').trim();
      if (reasoning) this.logStdout(agent.id, `reasoning: ${truncate(reasoning, 600)}`);
      this.logStdout(
        agent.id,
        turn.toolCalls && turn.toolCalls.length > 0
          ? `llm_response toolCalls=[${turn.toolCalls.map((c) => c.name).join(', ')}]`
          : `llm_response toolCalls=[] (final answer)`,
      );

      messages.push(turn.assistantMessage);

      if (!turn.toolCalls || turn.toolCalls.length === 0) {
        await this.activityLog.tickEnd(agent.id, tickId, {
          ok: true,
          rounds,
          responseChars: (turn.content ?? '').length,
        });
        this.logStdout(agent.id, `tick end ok=true rounds=${rounds}`);
        return;
      }

      for (const call of turn.toolCalls) {
        const reply = await this.dispatchToolCall(agent.id, tickId, call, toolByName, ctx);
        messages.push(reply);
      }
    }

    await this.activityLog.error(agent.id, tickId, {
      message: `exceeded ${AGENT_RUNNER.maxToolRoundsPerTick} tool-call rounds`,
    });
    await this.activityLog.tickEnd(agent.id, tickId, { ok: false, rounds });
    this.logStdout(agent.id, `tick end ok=false rounds=${rounds} (exceeded maxToolRoundsPerTick)`);
  }

  // ... keep dispatchToolCall, logStdout, buildSystemPrompt, loadOrInitMemory, memoryUpdatePayload, logStdoutMemory unchanged
}
```

Note: chat ticks need to surface tick failures to the SSE stream, so `run` now rethrows errors after logging them. Existing `AgentOrchestrator` already wraps `runner.run` in try/catch (defense-in-depth) — we add the same wrapping in the SSE route handler.

- [ ] **Step 2: Run live test for AgentRunner**

```bash
npm test -- agent-runner.live.test
```

Expected: PASS — refactor preserves scheduled-tick behavior. If the test catches a behavior change, fix the regression before continuing.

- [ ] **Step 3: Manual smoke**

```bash
npm start
```

Expected: existing seed agent ticks the same as before. New `user_message` event appears in `db/activity-log/<agentId>.json` with content `"Run one tick."` Stop after one tick.

- [ ] **Step 4: Commit**

```bash
git add src/agent-runner/
git commit -m "refactor(agent-runner): extract runToolLoop, accept TickStrategy + onToken option"
```

---

## Task 8: AgentOrchestrator filters chat agents

**Files:**
- Modify: `src/agent-looper/agent-orchestrator.ts`

- [ ] **Step 1: Filter by `type`**

In `tick()`, change the `due` filter:

```ts
const due = all.filter(
  (a) => a.type === 'scheduled' && a.enabled && now - (a.lastTickAt ?? 0) >= a.intervalMs,
);
```

- [ ] **Step 2: Run orchestrator live test**

```bash
npm test -- agent-orchestrator.live.test
```

Expected: PASS. The existing test installs scheduled agents only, so behavior is unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/agent-looper/agent-orchestrator.ts
git commit -m "feat(orchestrator): skip chat-mode agents in scheduled tick filter"
```

---

## Task 9: Chat history projection (pure)

**Files:**
- Create: `src/agent-runner/tick-strategies/chat-history-projection.ts`

- [ ] **Step 1: Create projection module**

```ts
import type { AgentActivityLogEntry } from '../../agent-activity-log/types';
import type { ChatMessage, ToolCall } from '../llm-client';

export interface ChatMessageView {
  tickId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; argumentsJson: string }[];
  toolCallId?: string;
  createdAt: number;
}

export function projectChatMessages(entries: AgentActivityLogEntry[]): ChatMessageView[] {
  const out: ChatMessageView[] = [];
  for (const e of entries) {
    if (e.type === 'user_message') {
      const p = e.payload as { content: string };
      out.push({ tickId: e.tickId, role: 'user', content: p.content, createdAt: e.timestamp });
    } else if (e.type === 'llm_response') {
      const p = e.payload as { content: string; toolCalls?: { id: string; name: string; argumentsJson: string }[] };
      const view: ChatMessageView = { tickId: e.tickId, role: 'assistant', content: p.content, createdAt: e.timestamp };
      if (p.toolCalls && p.toolCalls.length > 0) {
        view.toolCalls = p.toolCalls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.argumentsJson }));
      }
      out.push(view);
    } else if (e.type === 'tool_result') {
      const p = e.payload as { id: string; tool: string; output: unknown };
      out.push({
        tickId: e.tickId,
        role: 'tool',
        toolCallId: p.id,
        content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output),
        createdAt: e.timestamp,
      });
    }
  }
  return out;
}

export function projectChatMessagesAsLLMMessages(entries: AgentActivityLogEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if (e.type === 'user_message') {
      const p = e.payload as { content: string };
      out.push({ role: 'user', content: p.content });
    } else if (e.type === 'llm_response') {
      const p = e.payload as { content: string; toolCalls?: { id: string; name: string; argumentsJson: string }[] };
      const toolCalls: ToolCall[] | undefined = p.toolCalls && p.toolCalls.length > 0
        ? p.toolCalls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.argumentsJson }))
        : undefined;
      out.push(toolCalls ? { role: 'assistant', content: p.content, toolCalls } : { role: 'assistant', content: p.content });
    } else if (e.type === 'tool_result') {
      const p = e.payload as { id: string; output: unknown };
      out.push({
        role: 'tool',
        toolCallId: p.id,
        content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output),
      });
    }
  }
  return out;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/tick-strategies/chat-history-projection.ts
git commit -m "feat(agent-runner): add chat-history projection (activity log → messages)"
```

---

## Task 10: ChatTickStrategy

**Files:**
- Create: `src/agent-runner/tick-strategies/chat-tick-strategy.ts`

- [ ] **Step 1: Create strategy**

```ts
import type { AgentActivityLog } from '../../agent-activity-log/agent-activity-log';
import type { ChatMessage } from '../llm-client';
import { projectChatMessagesAsLLMMessages } from './chat-history-projection';
import type { TickStrategy, TickStrategyContext, TickStrategyResult } from './tick-strategy';

const HISTORY_LIMIT = 200;

export class ChatTickStrategy implements TickStrategy {
  constructor(
    private readonly activityLog: AgentActivityLog,
    private readonly userMessage: string,
  ) {}

  async buildInitialMessages(ctx: TickStrategyContext): Promise<TickStrategyResult> {
    const entries = await this.activityLog.list(ctx.agent.id, { limit: HISTORY_LIMIT });
    const history = projectChatMessagesAsLLMMessages(entries);
    const messages: ChatMessage[] = [
      { role: 'system', content: ctx.systemPrompt },
      ...history,
      { role: 'user', content: this.userMessage },
    ];
    return { userMessageContent: this.userMessage, initialMessages: messages };
  }
}
```

`HISTORY_LIMIT = 200` is intentional: a hard ceiling that cannot be configured via env or per-agent in v1. The follow-up sliding-window strategy from the spec replaces this when transcript cost becomes a concern.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner/tick-strategies/chat-tick-strategy.ts
git commit -m "feat(agent-runner): add ChatTickStrategy (replays activity log, appends user msg)"
```

---

## Task 11: Streaming hook on `LLMClient`

**Files:**
- Modify: `src/agent-runner/llm-client.ts`
- Modify: `src/agent-runner/stub-llm-client.ts`
- Modify: `src/ai/chat-model/zerog-llm-client.ts`

- [ ] **Step 1: Add `InvokeOptions` to interface**

In `src/agent-runner/llm-client.ts`, replace the `invokeWithTools` line and add the options type:

```ts
export interface InvokeOptions {
  onToken?: (text: string) => void;
}

export interface LLMClient {
  modelName(): string;
  invoke(prompt: string): Promise<LLMResponse>;
  invokeWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: InvokeOptions,
  ): Promise<LLMTurnResult>;
}
```

- [ ] **Step 2: Update `StubLLMClient`**

In `src/agent-runner/stub-llm-client.ts`, accept `options` in `invokeWithTools` and call `options.onToken(canned)` before returning. The stub doesn't need to chunk; emitting a single token call is sufficient for tests.

- [ ] **Step 3: Update `ZeroGLLMClient` to stream**

In `src/ai/chat-model/zerog-llm-client.ts`, modify `invokeWithToolsOnce` to branch on `options.onToken`. When set, use the OpenAI streaming API and assemble the final `LLMTurnResult` from chunks.

```ts
async invokeWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options?: InvokeOptions,
): Promise<LLMTurnResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= this.retries; attempt++) {
    try {
      return options?.onToken
        ? await this.invokeWithToolsStreaming(messages, tools, options.onToken)
        : await this.invokeWithToolsOnce(messages, tools);
    } catch (err) {
      lastErr = err;
      if (attempt < this.retries) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

private async invokeWithToolsStreaming(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  onToken: (text: string) => void,
): Promise<LLMTurnResult> {
  const headers = (await this.broker.inference.getRequestHeaders(this.providerAddress)) as unknown as Record<string, string>;
  const stream = await this.openai.chat.completions.create(
    {
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
      stream: true,
    },
    { headers },
  );

  let content = '';
  let completionId = '';
  // tool-call assembly: OpenAI streams tool_calls as deltas indexed by `index`
  const toolCallAccumulator = new Map<number, { id: string; name: string; argumentsJson: string }>();

  for await (const chunk of stream) {
    completionId = completionId || chunk.id;
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      content += delta.content;
      onToken(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        const acc = toolCallAccumulator.get(idx) ?? { id: '', name: '', argumentsJson: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.argumentsJson += tc.function.arguments;
        toolCallAccumulator.set(idx, acc);
      }
    }
  }

  const toolCalls: ToolCall[] = [...toolCallAccumulator.values()].filter((c) => c.id);

  // Settlement validation (best-effort; mirrors non-streaming path).
  try {
    const isValid = await this.broker.inference.processResponse(this.providerAddress, completionId, content);
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
    assistantMessage,
  };
}
```

- [ ] **Step 4: Run existing live test**

```bash
npm test -- zerog
```

Expected: PASS — non-streaming path is unchanged.

- [ ] **Step 5: Add streaming live test (extend the existing test file)**

Find the existing live test for `ZeroGLLMClient` (`grep -r 'ZeroGLLMClient' src/ --include='*.live.test.ts'`). In the same file, add a test that calls `invokeWithTools` with `onToken` and a trivial prompt (no tools), asserts that `onToken` was called at least once and the assembled `content` matches the non-streaming output's shape. Skip the test if the bootstrap state file is missing (existing pattern).

- [ ] **Step 6: Run new test**

```bash
npm test -- zerog
```

Expected: PASS (or SKIP if no bootstrap state — same as the existing test).

- [ ] **Step 7: Commit**

```bash
git add src/agent-runner/llm-client.ts src/agent-runner/stub-llm-client.ts src/ai/chat-model/zerog-llm-client.ts
git commit -m "feat(llm-client): add onToken streaming option on invokeWithTools"
```

---

## Task 12: Cursor pagination utility

**Files:**
- Create: `src/api-server/pagination/cursor.ts`

- [ ] **Step 1: Create encode/decode**

```ts
export interface Cursor {
  createdAt: number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): Cursor {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Cursor;
    if (typeof parsed.createdAt !== 'number' || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor shape');
    }
    return parsed;
  } catch {
    throw new Error('invalid cursor');
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/pagination/cursor.ts
git commit -m "feat(api-server): add cursor encode/decode util"
```

---

## Task 13: SSE writer wrapper

**Files:**
- Create: `src/api-server/sse/event-stream.ts`

- [ ] **Step 1: Implement writer**

```ts
import type { Response } from 'express';

const KEEPALIVE_INTERVAL_MS = 15_000;

export class SseWriter {
  private keepalive: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    this.keepalive = setInterval(() => {
      if (this.closed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        this.close();
      }
    }, KEEPALIVE_INTERVAL_MS);
    res.on('close', () => this.close());
  }

  send(event: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    try {
      this.res.end();
    } catch {
      // ignored
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/sse/event-stream.ts
git commit -m "feat(api-server): add SSE writer with heartbeat + close handling"
```

---

## Task 14: Auth middleware (stub)

**Files:**
- Create: `src/api-server/middleware/auth.ts`

- [ ] **Step 1: Implement**

```ts
import type { NextFunction, Request, Response } from 'express';
import type { AgentConfig } from '../../database/types';

export interface ApiUser {
  id: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: ApiUser;
    }
  }
}

const STUB_USER: ApiUser = { id: 'local-dev' };

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // v1 stub: any request gets a fixed user; JWT decode lands here later.
  req.user = STUB_USER;
  next();
}

export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'ForbiddenError';
  }
}

export function assertAgentOwnedBy(agent: AgentConfig, _user: ApiUser): void {
  // v1 noop. When AgentConfig gains userId, compare and throw ForbiddenError on mismatch.
  void agent;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/middleware/auth.ts
git commit -m "feat(api-server): add auth middleware shim + ownership helper"
```

---

## Task 15: Error handler middleware

**Files:**
- Create: `src/api-server/middleware/error-handler.ts`

- [ ] **Step 1: Implement**

```ts
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ForbiddenError } from './auth';

export class NotFoundError extends Error {
  constructor(public readonly errorCode = 'agent_not_found') {
    super(errorCode);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends Error {
  constructor(public readonly errorCode: string, message?: string) {
    super(message ?? errorCode);
    this.name = 'BadRequestError';
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', issues: err.issues });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.errorCode });
    return;
  }
  if (err instanceof ForbiddenError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.errorCode, message: err.message });
    return;
  }
  const e = err as Error;
  console.error('[api-server] unhandled error:', e);
  res.status(500).json({ error: 'internal_error', message: e.message });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/middleware/error-handler.ts
git commit -m "feat(api-server): add error handler with domain-error mapping"
```

---

## Task 16: CORS middleware

**Files:**
- Create: `src/api-server/middleware/cors.ts`

- [ ] **Step 1: Implement**

```ts
import cors from 'cors';
import type { RequestHandler } from 'express';

export function buildCorsMiddleware(originsCsv: string | undefined): RequestHandler {
  if (!originsCsv || originsCsv.trim() === '*') {
    return cors({ origin: true, credentials: false });
  }
  const allow = originsCsv.split(',').map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: (origin, cb) => {
      if (!origin || allow.includes(origin)) return cb(null, true);
      cb(new Error(`origin ${origin} not allowed`));
    },
    credentials: false,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/middleware/cors.ts
git commit -m "feat(api-server): add CORS middleware (env-driven allow-list)"
```

---

## Task 17: OpenAPI schemas (request/response shapes)

**Files:**
- Create: `src/api-server/openapi/schemas.ts`

- [ ] **Step 1: Define zod schemas**

```ts
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const AgentTypeSchema = z.enum(['scheduled', 'chat']).openapi({ description: 'Agent execution mode' });

export const RiskLimitsSchema = z.object({
  maxTradeUSD: z.number().nonnegative(),
  maxSlippageBps: z.number().int().nonnegative(),
}).passthrough();

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: AgentTypeSchema,
  enabled: z.boolean(),
  intervalMs: z.number().int().nonnegative(),
  prompt: z.string(),
  walletAddress: z.string(),
  dryRun: z.boolean(),
  dryRunSeedBalances: z.record(z.string()).optional(),
  riskLimits: RiskLimitsSchema,
  lastTickAt: z.number().nullable(),
  lastMessageAt: z.number().nullable().optional(),
  createdAt: z.number(),
}).openapi('AgentConfig');

export const CreateAgentBodySchema = z.object({
  name: z.string().min(1),
  type: AgentTypeSchema,
  prompt: z.string().min(1),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  dryRun: z.boolean(),
  dryRunSeedBalances: z.record(z.string()).optional(),
  riskLimits: RiskLimitsSchema,
  intervalMs: z.number().int().nonnegative().default(0),
}).openapi('CreateAgentBody');

export const UpdateAgentBodySchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  riskLimits: RiskLimitsSchema.optional(),
  intervalMs: z.number().int().nonnegative().optional(),
}).openapi('UpdateAgentBody');

export const PostMessageBodySchema = z.object({
  content: z.string().min(1),
}).openapi('PostMessageBody');

export const ChatMessageViewSchema = z.object({
  tickId: z.string(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    argumentsJson: z.string(),
  })).optional(),
  toolCallId: z.string().optional(),
  createdAt: z.number(),
}).openapi('ChatMessageView');

export const ActivityLogEntrySchema = z.object({
  agentId: z.string(),
  tickId: z.string(),
  timestamp: z.number(),
  type: z.enum(['user_message', 'tick_start', 'tick_end', 'tool_call', 'tool_result', 'llm_call', 'llm_response', 'memory_update', 'error']),
  payload: z.record(z.unknown()),
}).openapi('ActivityLogEntry');

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const PageOfActivitySchema = z.object({
  items: z.array(ActivityLogEntrySchema),
  nextCursor: z.string().nullable(),
}).openapi('PageOfActivity');

export const PageOfMessagesSchema = z.object({
  items: z.array(ChatMessageViewSchema),
  nextCursor: z.string().nullable(),
}).openapi('PageOfMessages');

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
}).openapi('ErrorResponse');
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/openapi/schemas.ts
git commit -m "feat(api-server): add zod schemas for openapi registry"
```

---

## Task 18: OpenAPI document builder

**Files:**
- Create: `src/api-server/openapi/spec-builder.ts`

- [ ] **Step 1: Build document**

```ts
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  registry,
  AgentConfigSchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
  PostMessageBodySchema,
  PageOfActivitySchema,
  PageOfMessagesSchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  AgentTypeSchema,
} from './schemas';

function registerPaths(): void {
  registry.registerPath({
    method: 'get',
    path: '/agents',
    request: {
      query: z.object({ type: AgentTypeSchema.optional() }),
    },
    responses: {
      200: { description: 'list of agents', content: { 'application/json': { schema: z.array(AgentConfigSchema) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents',
    request: { body: { content: { 'application/json': { schema: CreateAgentBodySchema } } } },
    responses: {
      201: { description: 'created', content: { 'application/json': { schema: AgentConfigSchema } } },
      400: { description: 'invalid input', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'agent', content: { 'application/json': { schema: AgentConfigSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/agents/{id}',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateAgentBodySchema } } },
    },
    responses: {
      200: { description: 'updated', content: { 'application/json': { schema: AgentConfigSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/agents/{id}',
    request: { params: z.object({ id: z.string() }) },
    responses: { 204: { description: 'deleted' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/start',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'started', content: { 'application/json': { schema: AgentConfigSchema } } },
      400: { description: 'wrong type', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/stop',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'stopped', content: { 'application/json': { schema: AgentConfigSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}/activity',
    request: {
      params: z.object({ id: z.string() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: { description: 'activity page', content: { 'application/json': { schema: PageOfActivitySchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}/messages',
    request: {
      params: z.object({ id: z.string() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: { description: 'messages page', content: { 'application/json': { schema: PageOfMessagesSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/messages',
    description:
      'Streams an SSE response. Each `data:` line is a JSON object with one of types: token, tool_call, tool_result, error, done.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: PostMessageBodySchema } } },
    },
    responses: {
      200: { description: 'SSE stream', content: { 'text/event-stream': { schema: z.string() } } },
    },
  });
}

let registered = false;

export function buildOpenApiDocument(): object {
  if (!registered) {
    registerPaths();
    registered = true;
  }
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Agent Loop API', version: '0.1.0' },
    servers: [{ url: '/' }],
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/openapi/spec-builder.ts
git commit -m "feat(api-server): build OpenAPI 3.1 document from zod schemas"
```

---

## Task 19: Routes — agents CRUD + start/stop

**Files:**
- Create: `src/api-server/routes/agents.ts`

- [ ] **Step 1: Implement router factory**

```ts
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/database';
import type { AgentConfig } from '../../database/types';
import { assertAgentOwnedBy } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import {
  AgentTypeSchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
} from '../openapi/schemas';

interface Deps {
  db: Database;
  clock?: () => number;
}

export function buildAgentsRouter(deps: Deps): Router {
  const r = Router();
  const now = () => (deps.clock ? deps.clock() : Date.now());

  r.get('/', async (req, _res, next) => {
    try {
      const typeFilter = req.query.type
        ? AgentTypeSchema.parse(req.query.type)
        : undefined;
      let agents = await deps.db.agents.list();
      if (typeFilter) agents = agents.filter((a) => a.type === typeFilter);
      _res.json(agents);
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    try {
      const body = CreateAgentBodySchema.parse(req.body);
      const agent: AgentConfig = {
        id: randomUUID(),
        name: body.name,
        type: body.type,
        enabled: false,
        intervalMs: body.intervalMs,
        prompt: body.prompt,
        walletAddress: body.walletAddress,
        dryRun: body.dryRun,
        ...(body.dryRunSeedBalances ? { dryRunSeedBalances: body.dryRunSeedBalances } : {}),
        riskLimits: body.riskLimits,
        lastTickAt: null,
        ...(body.type === 'chat' ? { lastMessageAt: null } : {}),
        createdAt: now(),
      };
      await deps.db.agents.upsert(agent);
      res.status(201).json(agent);
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  r.patch('/:id', async (req, res, next) => {
    try {
      const body = UpdateAgentBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);

      if (body.intervalMs !== undefined && agent.type !== 'scheduled') {
        throw new BadRequestError('unsupported_for_agent_type', 'intervalMs is scheduled-only');
      }

      const updated: AgentConfig = {
        ...agent,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.riskLimits !== undefined ? { riskLimits: body.riskLimits } : {}),
        ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
      };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      await deps.db.agents.delete(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/start', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'scheduled') {
        throw new BadRequestError('unsupported_for_agent_type', 'start is scheduled-only');
      }
      const updated: AgentConfig = { ...agent, enabled: true };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/stop', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'scheduled') {
        throw new BadRequestError('unsupported_for_agent_type', 'stop is scheduled-only');
      }
      const updated: AgentConfig = { ...agent, enabled: false };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/routes/agents.ts
git commit -m "feat(api-server): add agents CRUD + start/stop routes"
```

---

## Task 20: Route — paginated activity log

**Files:**
- Create: `src/api-server/routes/activity.ts`

- [ ] **Step 1: Implement**

```ts
import { Router } from 'express';
import type { AgentActivityLog } from '../../agent-activity-log/agent-activity-log';
import type { AgentActivityLogEntry } from '../../agent-activity-log/types';
import type { Database } from '../../database/database';
import { assertAgentOwnedBy } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import { PaginationQuerySchema } from '../openapi/schemas';

interface Deps {
  db: Database;
  activityLog: AgentActivityLog;
}

export function buildActivityRouter(deps: Deps): Router {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const agent = await deps.db.agents.findById(agentId);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);

      const q = PaginationQuerySchema.parse(req.query);
      let entries: AgentActivityLogEntry[] = await deps.activityLog.list(agentId);

      // entries are append-order (asc by timestamp). Apply cursor + order.
      if (q.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(q.cursor);
        } catch {
          throw new BadRequestError('invalid_cursor');
        }
        if (q.order === 'desc') {
          entries = entries.filter(
            (e) =>
              e.timestamp < cursor.createdAt ||
              (e.timestamp === cursor.createdAt && entryId(e) < cursor.id),
          );
        } else {
          entries = entries.filter(
            (e) =>
              e.timestamp > cursor.createdAt ||
              (e.timestamp === cursor.createdAt && entryId(e) > cursor.id),
          );
        }
      }

      if (q.order === 'desc') entries = [...entries].reverse();

      const items = entries.slice(0, q.limit);
      const last = items[items.length - 1];
      const nextCursor =
        items.length === q.limit && last
          ? encodeCursor({ createdAt: last.timestamp, id: entryId(last) })
          : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

function entryId(e: AgentActivityLogEntry): string {
  // FileActivityLogStore writes line by line; we don't have a stable per-row id.
  // Synthesize from tickId + type + timestamp for cursor uniqueness.
  return `${e.tickId}:${e.type}:${e.timestamp}`;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/routes/activity.ts
git commit -m "feat(api-server): add paginated activity log route"
```

---

## Task 21: Route — chat messages (GET paginated, POST SSE)

**Files:**
- Create: `src/api-server/routes/messages.ts`

- [ ] **Step 1: Implement**

```ts
import { Router } from 'express';
import type { AgentActivityLog } from '../../agent-activity-log/agent-activity-log';
import type { AgentRunner } from '../../agent-runner/agent-runner';
import { ChatTickStrategy } from '../../agent-runner/tick-strategies/chat-tick-strategy';
import {
  projectChatMessages,
  type ChatMessageView,
} from '../../agent-runner/tick-strategies/chat-history-projection';
import type { Database } from '../../database/database';
import { assertAgentOwnedBy } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import { PaginationQuerySchema, PostMessageBodySchema } from '../openapi/schemas';
import { SseWriter } from '../sse/event-stream';

interface Deps {
  db: Database;
  activityLog: AgentActivityLog;
  runner: AgentRunner;
}

export function buildMessagesRouter(deps: Deps): Router {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const agent = await deps.db.agents.findById(agentId);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'chat') {
        throw new BadRequestError('unsupported_for_agent_type', 'messages are chat-only');
      }

      const q = PaginationQuerySchema.parse(req.query);
      const entries = await deps.activityLog.list(agentId);
      let views: ChatMessageView[] = projectChatMessages(entries);

      if (q.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(q.cursor);
        } catch {
          throw new BadRequestError('invalid_cursor');
        }
        if (q.order === 'desc') {
          views = views.filter(
            (v) =>
              v.createdAt < cursor.createdAt ||
              (v.createdAt === cursor.createdAt && viewId(v) < cursor.id),
          );
        } else {
          views = views.filter(
            (v) =>
              v.createdAt > cursor.createdAt ||
              (v.createdAt === cursor.createdAt && viewId(v) > cursor.id),
          );
        }
      }

      if (q.order === 'desc') views = [...views].reverse();

      const items = views.slice(0, q.limit);
      const last = items[items.length - 1];
      const nextCursor =
        items.length === q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: viewId(last) })
          : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    let sse: SseWriter | null = null;
    try {
      const agentId = (req.params as { id: string }).id;
      const body = PostMessageBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(agentId);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'chat') {
        throw new BadRequestError('unsupported_for_agent_type', 'messages are chat-only');
      }

      sse = new SseWriter(res);

      const strategy = new ChatTickStrategy(deps.activityLog, body.content);
      let assistantContent = '';
      try {
        await deps.runner.run(agent, strategy, {
          onToken: (text) => {
            assistantContent += text;
            sse!.send({ type: 'token', text });
          },
        });
        sse!.send({
          type: 'done',
          message: {
            role: 'assistant',
            content: assistantContent,
            createdAt: Date.now(),
          },
        });
      } catch (err) {
        sse!.send({ type: 'error', message: (err as Error).message });
      } finally {
        sse!.close();
        // bump lastMessageAt on the agent
        const fresh = await deps.db.agents.findById(agentId);
        if (fresh) await deps.db.agents.upsert({ ...fresh, lastMessageAt: Date.now() });
      }
    } catch (err) {
      if (sse && !sse.isClosed()) {
        sse.send({ type: 'error', message: (err as Error).message });
        sse.close();
        return;
      }
      next(err);
    }
  });

  return r;
}

function viewId(v: ChatMessageView): string {
  return `${v.tickId}:${v.role}:${v.toolCallId ?? ''}:${v.createdAt}`;
}
```

Note (superseded): an earlier draft of this plan deferred tool events. After the Phase 1+2 cleanups, `InvokeOptions` carries `onToolCall` and `onToolResult` callbacks that `AgentRunner.dispatchToolCall` invokes alongside its activity-log writes. The SSE route should pass them through `runner.run()` and forward each as a `data: {type:'tool_call', name, id}` / `data: {type:'tool_result', name, id, durationMs}` SSE event.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/routes/messages.ts
git commit -m "feat(api-server): add chat messages routes (GET paginated, POST SSE)"
```

---

## Task 22: Route — OpenAPI + Swagger UI

**Files:**
- Create: `src/api-server/routes/openapi.ts`

- [ ] **Step 1: Implement**

```ts
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from '../openapi/spec-builder';

export function buildOpenApiRouter(): Router {
  const r = Router();
  const doc = buildOpenApiDocument();
  r.get('/openapi.json', (_req, res) => res.json(doc));
  r.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
  return r;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/routes/openapi.ts
git commit -m "feat(api-server): mount /openapi.json + /docs (Swagger UI)"
```

---

## Task 23: ApiServer composition

**Files:**
- Create: `src/api-server/server.ts`

- [ ] **Step 1: Implement**

```ts
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import type { AgentRunner } from '../agent-runner/agent-runner';
import type { Database } from '../database/database';
import { authMiddleware } from './middleware/auth';
import { buildCorsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { buildAgentsRouter } from './routes/agents';
import { buildActivityRouter } from './routes/activity';
import { buildMessagesRouter } from './routes/messages';
import { buildOpenApiRouter } from './routes/openapi';

export interface ApiServerDeps {
  db: Database;
  activityLog: AgentActivityLog;
  runner: AgentRunner;
  port: number;
  corsOrigins?: string;
}

export class ApiServer {
  private readonly app: Express;
  private server: Server | null = null;

  constructor(private readonly deps: ApiServerDeps) {
    this.app = express();
    this.app.use(buildCorsMiddleware(deps.corsOrigins));
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(authMiddleware);

    this.app.use('/', buildOpenApiRouter());
    this.app.use('/agents', buildAgentsRouter({ db: deps.db }));
    this.app.use('/agents/:id/activity', buildActivityRouter({ db: deps.db, activityLog: deps.activityLog }));
    this.app.use('/agents/:id/messages', buildMessagesRouter({ db: deps.db, activityLog: deps.activityLog, runner: deps.runner }));

    this.app.use(errorHandler);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.deps.port, () => {
        console.log(`[api-server] listening on http://localhost:${this.deps.port} (docs: /docs)`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getApp(): Express {
    return this.app;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api-server/server.ts
git commit -m "feat(api-server): compose Express app with routes + middleware"
```

---

## Task 24: Env additions

**Files:**
- Modify: `src/config/env.ts`

- [ ] **Step 1: Add fields**

In `src/config/env.ts`, extend the schema:

```ts
PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
API_CORS_ORIGINS: z.string().optional(),
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "feat(config): add PORT + API_CORS_ORIGINS env vars"
```

---

## Task 25: Wire ApiServer into bootstrap

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Boot ApiServer after Looper**

In `src/index.ts`, after `looper.start();`, add:

```ts
import { ApiServer } from './api-server/server';

// ... inside main(), after looper.start()
const api = new ApiServer({
  db,
  activityLog,
  runner,
  port: env.PORT,
  ...(env.API_CORS_ORIGINS ? { corsOrigins: env.API_CORS_ORIGINS } : {}),
});
await api.start();
```

Update the SIGINT/SIGTERM handler to also stop the API:

```ts
const shutdown = async (signal: string) => {
  console.log(`[bootstrap] received ${signal}, stopping`);
  looper.stop();
  await api.stop().catch(() => {});
  process.exit(0);
};
```

- [ ] **Step 2: Typecheck + run**

```bash
npm run typecheck
npm start
```

Expected:
- `[bootstrap] looper started, ticking every <ms>ms`
- `[api-server] listening on http://localhost:3000 (docs: /docs)`

- [ ] **Step 3: Manual smoke — agents endpoints**

In another terminal:

```bash
curl -s http://localhost:3000/openapi.json | head -40
curl -s http://localhost:3000/agents | head -40
curl -s -X POST http://localhost:3000/agents -H 'content-type: application/json' -d '{
  "name": "smoke-chat",
  "type": "chat",
  "prompt": "You are a helpful assistant.",
  "walletAddress": "0x0000000000000000000000000000000000000001",
  "dryRun": true,
  "riskLimits": { "maxTradeUSD": 1, "maxSlippageBps": 50 },
  "intervalMs": 0
}'
curl -s http://localhost:3000/agents
```

Expected: spec returns JSON with `openapi: "3.1.0"`. Agents list grows.

- [ ] **Step 4: Manual smoke — chat SSE**

Use the agent id from the previous step (`<AGENT_ID>`):

```bash
curl -N -s -X POST http://localhost:3000/agents/<AGENT_ID>/messages \
  -H 'content-type: application/json' \
  -d '{"content": "Say hello in one short sentence."}'
```

Expected: a stream of `data: {"type":"token","text":"..."}` lines, ending with `data: {"type":"done", ...}`. If 0G isn't bootstrapped (StubLLMClient), expect a single `token` then `done` carrying the canned response.

- [ ] **Step 5: Manual smoke — chat history**

```bash
curl -s "http://localhost:3000/agents/<AGENT_ID>/messages?limit=20"
```

Expected: JSON `{ items: [...], nextCursor: null }` with the user message and assistant reply visible.

- [ ] **Step 6: Manual smoke — activity log**

```bash
curl -s "http://localhost:3000/agents/<AGENT_ID>/activity?limit=20"
```

Expected: JSON page with `user_message`, `tick_start`, `llm_call`, `llm_response`, `tick_end` events (in `desc` order by default).

- [ ] **Step 7: Stop server, commit**

`Ctrl+C` the running `npm start`. Then:

```bash
git add src/index.ts
git commit -m "feat: boot ApiServer alongside Looper"
```

---

## Task 26: README — running the API

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a short section**

Append to `README.md`:

```markdown
## API Server

The Looper boots an Express HTTP server on `PORT` (default `3000`).

- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI 3.1 spec (consume from FE to generate SDK)
- `GET /agents`, `POST /agents`, `GET /agents/:id`, `PATCH /agents/:id`, `DELETE /agents/:id`
- `POST /agents/:id/start`, `POST /agents/:id/stop` — scheduled agents only
- `GET /agents/:id/activity?cursor=&limit=&order=desc|asc` — paginated activity log
- `GET /agents/:id/messages?cursor=&limit=&order=desc|asc` — paginated chat history (chat agents only)
- `POST /agents/:id/messages` — send a chat message; response is `text/event-stream` with `token`/`done`/`error` events

### Frontend SDK generation

```bash
# in the FE repo:
npm install -D openapi-typescript
npm install openapi-fetch
curl -o openapi.json http://localhost:3000/openapi.json
npx openapi-typescript openapi.json -o src/api-types.ts
```

Use `openapi-fetch<paths>` for typed requests against the generated `paths` type. Chat SSE is hand-written (use `fetch` + a `ReadableStream` reader, or `EventSource` if the endpoint accepts GET — note our v1 chat endpoint is `POST` so use `fetch`).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document API server endpoints + SDK generation"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Implemented in |
| ------------ | -------------- |
| D1 Same process as Looper | Task 25 |
| D2 `type` discriminator | Task 2 |
| D3 TickStrategy split | Tasks 6, 7, 10 |
| D4 One user msg = one tick | Task 7 (runner refactor), Task 21 (route) |
| D5 Activity log = chat store | Tasks 4, 5, 9 |
| D6 SSE streaming | Tasks 11, 13, 21 |
| D7 OpenAPI tooling | Tasks 17, 18, 22 |
| D8 Auth shim | Task 14 |
| D9 Start/stop = enabled flip | Task 19 |
| D10 Cursor pagination | Tasks 12, 20, 21 |
| Type changes to AgentConfig | Task 2 |
| Streaming hook on LLMClient | Task 11 |
| SSE writer | Task 13 |
| CORS | Task 16 |
| Error handling | Task 15 |
| Storage layout (no new repo) | Tasks 4, 5 |
| Migration / rollout | Tasks 1–25 (mirror order) |

**Known scope deferral baked into the plan:**

- Tool-call / tool-result events are NOT streamed over SSE in v1 (Task 21 note). The FE re-fetches `GET /agents/:id/messages` after `done` to pick up tool messages. Documented inline.
- Cancel-mid-stream — left as the spec's open item.

**Type consistency check:**
- `ChatMessageView` (Task 9) used by Tasks 17, 21 — same shape.
- `AgentConfig` field set used identically across Tasks 2, 17, 19.
- `AgentActivityLog.userMessage(agentId, tickId, { content })` (Task 5) called from Task 7.
- `LLMClient.invokeWithTools` signature (Task 11) consumed in Task 7's `runToolLoop`.
- Cursor encode/decode signature (Task 12) consumed in Tasks 20, 21.

**Placeholder scan:** none.
