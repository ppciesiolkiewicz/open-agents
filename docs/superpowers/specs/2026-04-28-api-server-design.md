# API Server — Design

**Date:** 2026-04-28
**Status:** Brainstorming phase
**Scope:** REST API server (Express) exposing agent management, activity log retrieval, and chat-mode interaction. Runs in the same Node process as the Looper. Generates an OpenAPI spec consumed by the frontend SDK. Auth deferred but designed for JWT.

## Goal

Add an HTTP surface that lets a frontend:

- Create, list, inspect, update, and delete agents
- Start/stop scheduled agents
- Read paginated activity logs
- Hold real-time chat sessions with chat-mode agents (SSE streaming)
- Generate a typed TypeScript SDK from a published OpenAPI spec

The agent execution core (`AgentRunner`, `AgentOrchestrator`, `WalletFactory`, `Database`, `AgentActivityLog`) is reused unchanged in shape. Two extension points are added: a new agent `type` discriminator (`scheduled` | `chat`), and a new `user_message` event type on the existing activity log (chat content lives there, not in a separate store).

## Non-Goals (v1)

- Real authentication — middleware shim returns a stub user; ownership checks are no-ops until `userId` lands on `AgentConfig`
- Multi-user isolation in storage — single shared DB; design accommodates future per-user partitioning
- Multi-process deployment — server and Looper share one Node process
- Token streaming for scheduled ticks — only chat ticks stream
- Branching/multi-thread chats per agent — one chat agent = one linear transcript
- Rate limiting / quotas
- Multi-participant chat
- Sliding-window history truncation — full transcript replayed every chat tick (deferred follow-up; see Open Items)

## Decisions

### D1. Same process as Looper

Express boots from `src/index.ts` after the Looper. The server holds direct references to `db`, `orchestrator`, `runner`, `walletFactory`, `activityLog`. No IPC. Matches the existing "single process, worker-ready" decision in CLAUDE.md.

`AgentRunner.run()` remains a callable taking config + deps so a future split into a dedicated server process is mechanical.

### D2. Reuse `AgentRepository` with a `type` discriminator

`AgentConfig` gains a `type: 'scheduled' | 'chat'` field. Scheduled-only fields (`enabled`, `intervalMs`, `lastTickAt`) become optional. Chat-only fields are minimal (`lastMessageAt?: number | null`). `WalletFactory.forAgent`, `AgentRunner.run`, risk limit enforcement, dry-run plumbing, and activity-log writes all stay agent-type-agnostic.

Rationale: shared fields dominate (wallet, prompt, dryRun, riskLimits, createdAt, name). One repo, one auth path, one runner. A separate `ChatAgent` entity would duplicate fields and fork tooling for no real benefit.

### D3. Chat tick reuses `AgentRunner` core loop

`AgentRunner.run()` is refactored to extract its message-construction step. The tool/round loop (`LLM call → tool dispatch → repeat → final assistant message`) is shared. Two strategies feed it:

- `ScheduledTickStrategy` — system prompt + `[{role:'user', content:'Run one tick.'}]` (current behavior)
- `ChatTickStrategy` — system prompt + replayed prior chat history + new user message

Same `maxToolRoundsPerTick`, same activity-log writes, same memory injection, same wallet, same tool registry.

### D4. One user message = one chat tick

Tick boundary = user message boundary. Inside a chat tick the model may invoke many tools across many LLM rounds (same `tickId`, same activity-log thread, same round cap). The tick ends when the LLM returns final text with no tool calls — that text is recorded as a final `llm_response` activity-log event and emitted to the SSE stream.

### D5. Chat transcript lives in the activity log

No new repository. The activity log already records every message the LLM emits (`llm_response` carries `content` + `toolCalls`) and every tool round (`tool_call`, `tool_result`). The only thing missing is the **user's input** — today scheduled ticks hardcode `"Run one tick."` and never log it.

We add one new event type:

```ts
type AgentActivityLogEntryType =
  | 'user_message'      // NEW — { content: string }
  | 'tick_start' | 'tick_end'
  | 'tool_call' | 'tool_result'
  | 'llm_call' | 'llm_response'
  | 'memory_update' | 'error';
```

`AgentRunner` writes a `user_message` event **before** `tick_start` at the entry of every tick. Scheduled ticks log `{ content: "Run one tick." }` for symmetry. Chat ticks log the user's actual text, persisted before any LLM cost is incurred — durable independent of tick success.

**Reading chat history** (server-side, for the next tick's `messages[]`, and for `GET /agents/:id/messages`): a pure function in `chat-history-projection.ts` replays activity events for the agent in `createdAt` order and projects them into OpenAI message shape, plus a FE-friendly view shape:

```ts
interface ChatMessageView {
  tickId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; argumentsJson: string }[];
  toolCallId?: string;
  createdAt: number;
}
```

| Activity event           | Projected message                                                 |
| ------------------------ | ----------------------------------------------------------------- |
| `user_message`           | `{ role: 'user', content }`                                       |
| `llm_response` (any)     | `{ role: 'assistant', content, toolCalls? }`                      |
| `tool_result`            | `{ role: 'tool', toolCallId, content: output-as-string }`         |
| everything else          | filtered out                                                      |

`tickId` already threads each user message to its downstream assistant/tool events, so the projection is unambiguous even with multi-round tool use.

**Why reuse:**
- One source of truth per tick. No drift between two stores.
- `tickId` correlation already exists; no new join key.
- Pagination + storage already solved (`activity-log/<agentId>.json`).
- Net new code is one event type plus one read-side projection function.

**Trade accepted:** `GET /agents/:id/messages` filters event types and projects on read. If activity-log volume ever forces a retention/rotation policy, that policy must exclude chat-bearing events (or rotate per-tick, not per-event). Not a v1 problem.

### D6. SSE streaming for chat

`POST /agents/:id/messages` accepts a JSON body `{ content: string }` and returns `text/event-stream`. The user's `content` is logged as a `user_message` activity event before the stream opens, so it survives a mid-stream disconnect. Events emitted:

- `{ type: 'token', text }` — incremental LLM output
- `{ type: 'tool_call', id, name, argumentsJson }` — model invoked a tool
- `{ type: 'tool_result', toolCallId, output, durationMs }` — tool finished
- `{ type: 'error', message }` — recoverable error mid-stream
- `{ type: 'done', message: ChatMessageView }` — final assistant message (projected from the activity-log event)

Streaming hook lives on `LLMClient.invokeWithTools` as an optional `onToken` callback. `ZeroGLLMClient` sets `stream: true` on the underlying OpenAI request when the callback is present. Scheduled ticks pass no callback → unchanged buffered behavior.

OpenAPI describes the endpoint as `text/event-stream` with the event payload union schema. The generated SDK client does **not** consume SSE; the FE uses native `EventSource` (or a `fetch` reader wrapper) for chat. This is a hand-written FE module separate from the generated client.

### D7. OpenAPI tooling

- `zod-to-openapi` builds the OpenAPI 3.1 document from existing `zod` request/response schemas. We already use `zod` for env validation and tool inputs, so the dependency footprint is small.
- The server exposes:
  - `GET /openapi.json` — raw spec
  - `GET /docs` — Swagger UI via `swagger-ui-express`
- Frontend SDK: `openapi-typescript` (compile-time types) + `openapi-fetch` (typed runtime client). No codegen runtime, no generated classes — types from spec, client is a thin wrapper.

This stack is deliberately minimal. The alternative (`openapi-generator`, `tsoa`, `nestjs/swagger`) brings code generation pipelines and decorator runtimes we do not need.

### D8. Auth as a middleware shim, JWT-ready

A single `authMiddleware` reads `Authorization: Bearer <jwt>` if present and attaches `req.user = { id }` to the request. v1 stub returns `{ id: 'local-dev' }` when no JWT is present. All resources are keyed by `agentId` in URLs.

Ownership enforcement lives in one helper, `assertAgentOwnedBy(agent, user)`, called inside route handlers. v1 implementation no-ops because `AgentConfig` has no `userId` yet. When real auth lands:

1. Add `userId: string` to `AgentConfig`
2. Set it on agent creation from `req.user.id`
3. Flip the stub off
4. The helper starts enforcing

Endpoint signatures do not change.

### D9. Start/stop = `enabled` flag flip

`POST /agents/:id/start` sets `enabled: true`; `POST /agents/:id/stop` sets `enabled: false`. Scheduled agents only — chat agents reject these endpoints with `400`. `AgentOrchestrator.tick()` already filters by `enabled` and `type === 'scheduled'` after the discriminator change.

No process-level lifecycle. The Looper keeps running; individual agents are gated by their flag.

### D10. Pagination — cursor-based

Cursor encodes `(createdAt, id)` for stable ordering across ties. Format: opaque base64 string carrying `{ createdAt, id }`. Page size capped server-side (default 50, max 200). Both activity log and chat history use the same shape:

```
GET /agents/:id/activity?cursor=<opaque>&limit=50&order=desc
GET /agents/:id/messages?cursor=<opaque>&limit=50&order=desc
```

Response:
```ts
{ items: T[], nextCursor: string | null }
```

`order` defaults to `desc` (newest first) — chat UIs render newest at the bottom and load older pages on scroll-up; ops users similarly want most-recent activity first. `asc` is supported for full-history exports.

The activity log is already append-only on disk (`activity-log/<agentId>.json`); pagination reads the file and slices in memory. Acceptable for v1 sizes; switching to per-line JSONL with seek-based pagination is a future optimization.

## Architecture

### Module layout

```
src/
  api-server/
    server.ts                 ApiServer class — boots Express, wires routes
    routes/
      agents.ts               CRUD + start/stop
      activity.ts             paginated activity log
      messages.ts             SSE chat tick + paginated history
      openapi.ts              /openapi.json + /docs
    middleware/
      auth.ts                 authMiddleware (stub) + assertAgentOwnedBy
      error-handler.ts        zod errors → 400, domain errors → mapped status
      request-id.ts           attaches reqId for log correlation
    sse/
      event-stream.ts         SSE writer wrapper (cors, heartbeat, close handling)
    openapi/
      spec-builder.ts         composes zod schemas → OpenAPI document
      schemas.ts              zod schemas for request/response bodies
    pagination/
      cursor.ts               encode/decode opaque cursors
  agent-runner/
    agent-runner.ts           refactored: extracts runToolLoop()
    tick-strategies/
      scheduled-tick.ts       current behavior
      chat-tick.ts            replays activity log, appends user msg
      chat-history-projection.ts   activity events → ChatMessageView[] (pure)
  agent-activity-log/
    types.ts                  adds 'user_message' to AgentActivityLogEntryType
    agent-activity-log.ts     adds userMessage(agentId, tickId, content)
```

### Data flow — chat tick

```
client                  server                   runner              llm        activity log
  |  POST /messages       |                        |                   |             |
  |---------------------->|                        |                   |             |
  |                       | open SSE stream        |                   |             |
  |                       | runChatTick(agent, msg)|                   |             |
  |                       |                        | user_message --------------------|
  |                       |                        | tick_start ----------------------|
  |                       |                        | load history (replay log) ------>|
  |                       |                        | invokeWithTools(stream=true) -->|
  |                       |                        |   onToken(...)    |             |
  |  data: {token}<-------|<-----------------------|<------------------|             |
  |                       |                        | llm_response --------------------|
  |                       |                        | tool_call -----------------------|
  |  data: {tool_call}<---|<-----------------------|                   |             |
  |                       |                        | invoke tool       |             |
  |                       |                        | tool_result ---------------------|
  |  data: {tool_result}<-|<-----------------------|                   |             |
  |                       |                        | (loop until no tool calls)      |
  |                       |                        | tick_end ------------------------|
  |  data: {done}<--------|<-----------------------|                   |             |
  |                       | close stream           |                   |             |
```

### Endpoint surface

| Method | Path                              | Purpose                              | Modes        |
| ------ | --------------------------------- | ------------------------------------ | ------------ |
| POST   | `/agents`                         | Create agent (body picks type)       | both         |
| GET    | `/agents`                         | List agents (`?type=` filter)        | both         |
| GET    | `/agents/:id`                     | Get one                              | both         |
| PATCH  | `/agents/:id`                     | Update mutable fields                | both         |
| DELETE | `/agents/:id`                     | Delete                               | both         |
| POST   | `/agents/:id/start`               | `enabled = true`                     | scheduled    |
| POST   | `/agents/:id/stop`                | `enabled = false`                    | scheduled    |
| GET    | `/agents/:id/activity`            | Paginated activity log               | both         |
| POST   | `/agents/:id/messages`            | SSE chat tick                        | chat         |
| GET    | `/agents/:id/messages`            | Paginated chat history               | chat         |
| GET    | `/openapi.json`                   | OpenAPI 3.1 spec                     | —            |
| GET    | `/docs`                           | Swagger UI                           | —            |

Mutable fields on `PATCH`: `name`, `prompt`, `riskLimits`, `intervalMs` (scheduled only). Immutable: `id`, `walletAddress`, `dryRun`, `dryRunSeedBalances`, `type`, `createdAt`. Changing dry-run mode or wallet address mid-life is unsupported in v1.

### Type changes to `AgentConfig`

```ts
export interface AgentConfig {
  id: string;
  name: string;
  type: 'scheduled' | 'chat';      // NEW — discriminator
  prompt: string;
  walletAddress: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>;
  riskLimits: { maxTradeUSD: number; maxSlippageBps: number; [k: string]: unknown };
  createdAt: number;

  // scheduled-only (optional on the union)
  enabled?: boolean;
  intervalMs?: number;
  lastTickAt?: number | null;

  // chat-only
  lastMessageAt?: number | null;
}
```

Migration: existing agents in `database.json` lack `type`. On load, `AgentRepository` defaults missing `type` to `'scheduled'` (preserves all current behavior). New agents are written with `type` set explicitly.

### Streaming hook on `LLMClient`

```ts
interface InvokeOptions {
  onToken?: (text: string) => void;
}
interface LLMClient {
  invokeWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: InvokeOptions,
  ): Promise<LLMTurn>;
  modelName(): string;
}
```

`ZeroGLLMClient` opts into OpenAI streaming when `onToken` is set; assembles the final `LLMTurn` from streamed chunks. `StubLLMClient` invokes `onToken` once with its canned response (good enough for tests). Scheduled ticks pass no callback — unchanged buffered behavior, no risk to existing flows.

### SSE writer

A small helper in `sse/event-stream.ts`:

- Sets headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`)
- Emits typed events as `data: <json>\n\n`
- Sends a `: keep-alive` comment every 15s to defeat proxy idle timeouts
- Listens for `req.on('close')` to abort the in-flight tick (see Open Items)

### CORS

Browser FE calls the API directly. CORS allow-list driven by env (`API_CORS_ORIGINS=http://localhost:5173,https://...`). Default in dev: allow all origins. SSE responses include the same CORS headers.

### Error handling

- `zod` validation errors → `400` with `{ error: 'invalid_request', issues: [...] }`
- Unknown agent → `404 { error: 'agent_not_found' }`
- Wrong type for endpoint (e.g. start on chat agent) → `400 { error: 'unsupported_for_agent_type' }`
- Ownership mismatch (post-auth) → `403 { error: 'forbidden' }`
- Tool failures inside a chat tick → emitted as SSE `error` events; the tick continues per existing `AgentRunner` semantics (tool error becomes a tool message, model decides what to do)
- Tick exception before any SSE write → `500` with JSON body
- Tick exception after stream opened → SSE `error` event then close

A central error-handler middleware maps domain errors to HTTP status codes; routes throw, the middleware translates.

## Storage layout additions

No new storage. Chat content lives in the existing per-agent activity log at `./db/activity-log/<agentId>.json` as `user_message`, `llm_response`, `tool_call`, `tool_result` events. The activity log file already exists per-agent; chat reads slice + filter + project from it.

`AgentConfig` rows in `./db/database.json` gain the `type` field on write; reads default missing `type` to `'scheduled'` so existing agents keep working.

## Testing

Per CLAUDE.md, tests exist for modules that talk to external systems and are read-only / cheap. The API server module is internal — pure-logic — so it follows the same rule and gets no dedicated `*.live.test.ts`. End-to-end coverage comes from running `npm start`, hitting endpoints with a real frontend or `curl`, and observing the existing live tests for `ZeroGLLMClient`, `UniswapService`, providers, and `AgentRunner` continue to pass.

What does need a live test:

- `ZeroGLLMClient` streaming path — extend the existing test to exercise `onToken` against the real 0G proxy, asserting tokens arrive incrementally and the final turn matches the buffered shape.

What does not get tests:

- Express routes (no external system; covered by manual smoke + frontend usage)
- Pagination cursor encode/decode (pure logic)
- OpenAPI spec generation (pure logic; verified by `GET /openapi.json` returning a valid document)
- Tick strategies (covered by existing `AgentRunner` live test, which keeps using the scheduled strategy)

`scripts/` gains nothing new — no money-spending operations introduced.

## Migration / rollout

1. Add `type` field to `AgentConfig`, default to `'scheduled'` on load
2. Add `'user_message'` event type to activity log + `userMessage()` writer method
3. Refactor `AgentRunner` to extract `runToolLoop()` and accept a `TickStrategy`; both strategies log a `user_message` at tick entry
4. Add `chat-history-projection.ts` (activity events → OpenAI message shape) used by `ChatTickStrategy` for prompt assembly and by `GET /agents/:id/messages` for FE rendering
5. Add streaming hook to `LLMClient` interface + `ZeroGLLMClient`
6. Build `api-server/` module, wire into `index.ts` after Looper
7. Generate OpenAPI spec, mount `/openapi.json` and `/docs`
8. Frontend consumes `openapi.json`, regenerates SDK, hand-writes SSE chat module

Each step is a separate slice in the implementation plan.

## Open Items / Follow-ups

- **History truncation.** Full transcript replay per chat tick scales linearly with token cost on 0G. Add a sliding-window strategy (last N messages + memory summary) once transcripts grow. Not needed for v1.
- **Cancel mid-stream.** When the SSE client disconnects, abort the in-flight tick. v1 lets the tick finish (cheap; tick costs are bounded by `maxToolRoundsPerTick`). Wire `AbortController` through `LLMClient` and tool invocations as a follow-up.
- **OpenAPI for SSE.** OpenAPI 3.1 has weak SSE semantics; we describe the endpoint as `text/event-stream` and document event shapes in the description field. The generated client will not auto-handle it — a hand-written FE module covers chat.
- **Per-user partitioning.** When `userId` lands, decide whether storage stays single-collection with a filter or splits per-user (`db/users/<userId>/...`). v1 keeps single-collection; the repository interface hides the choice.
- **Rate limiting / quotas.** Out of scope; revisit when multi-user.
