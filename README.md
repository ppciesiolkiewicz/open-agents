# open-agents-agent-loop

TypeScript loop that fires AI agents on a schedule. Each agent gets an LLM-driven prompt with onchain (Uniswap v4 on Unichain) + offchain tools and persists every config, transaction, position, and tick to disk. Reference agent is a UNI/USDC moving-average trader.

## Setup

```bash
npm install
cp .env.example .env  # fill in keys
```

## Run

```bash
# 1. fund a 0G inference provider (one-time, ~3 OG)
npm run zerog-bootstrap          # lists providers
# set ZEROG_PROVIDER_ADDRESS=0x... in .env
npm run zerog-bootstrap          # this run actually funds + persists

# 2. install + run the seed agent
npm run seed-agent               # default dry-run; pass `-- --real` for real onchain
npm start                        # watch db/activity-log/ + db/memory/

# fresh start
npm run reset-db                 # preserves zerog-bootstrap.json
npm run reset-db -- --all        # wipes everything
```

## Scripts

| Command | What |
|---|---|
| `npm start` | run the agent loop |
| `npm test` / `npm run typecheck` / `npm run build` | dev loops; safe to run any time |
| `npm run zerog-bootstrap` | list / fund 0G inference provider |
| `npm run llm:probe` | sanity-check the LLM round trip |
| `npm run seed-agent` | install canonical UNI MA trader (`-- --real` for real onchain) |
| `npm run swap:buy-uni` / `npm run swap:sell-uni` | manual UNI/USDC swap on Unichain |
| `npm run reset-db` | wipe ephemeral db state |

Every fund-spending script prompts `[y/N]` before doing anything.

## Docs

- [CLAUDE.md](CLAUDE.md) — architecture decisions + coding standards
- [docs/superpowers/specs/](docs/superpowers/specs/) — design spec
- [docs/superpowers/plans/](docs/superpowers/plans/) — per-slice implementation plans

## API Server

`npm start` boots both the Looper and an Express HTTP server in the same process (`PORT`, default `3000`). To run them separately:

```bash
npm run start:looper    # MODE=looper — only the agent loop
npm run start:server    # MODE=server — only the HTTP API
npm start               # MODE=both (default) — both in one process
```

The two modes share the file-backed DB at `DB_DIR`. v1 has no file lock, so don't run `start:looper` and the seed/swap scripts at the same instant — for normal usage (one looper + one server) sequential reads/writes are fine. When the file DB is replaced with a real DB, this caveat goes away.

CORS allow-list via `API_CORS_ORIGINS` (CSV; omit for `*`).

Set `DOCS_PORT` to mount Swagger UI on its own port (e.g. `PORT=3000 DOCS_PORT=8000 npm run start:server` puts the API on `:3000` and Swagger UI on `:8000/docs`). When unset, `/docs` lives on the main port.

- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI 3.1 spec (consume from FE to generate SDK)
- `GET /agents`, `POST /agents`, `GET /agents/:id`, `PATCH /agents/:id`, `DELETE /agents/:id`
- `POST /agents/:id/start`, `POST /agents/:id/stop` — set `running = true/false` on any agent
- `GET /agents/:id/activity?cursor=&limit=&order=desc|asc` — paginated activity log
- `GET /agents/:id/messages?cursor=&limit=&order=desc|asc` — paginated chat history
- `POST /agents/:id/messages` — send a chat message; response is `text/event-stream`. Events: `queued` (if a task is ahead), `started`, `token`, `tool_call`, `tool_result`, `done`, `error`.

Auth is a stub in v1 (every request gets `user.id = 'local-dev'`). JWT decoding lands in the same middleware later; endpoint signatures stay the same.

### Unified agent model

There is no agent type discriminator. Every agent can:

- **Run on a schedule** — set `intervalMs >= 1000` and call `POST /agents/:id/start`. The orchestrator fires a scheduled tick whenever `running === true` and the interval has elapsed.
- **Accept chat messages** — call `POST /agents/:id/messages` at any time, regardless of `running` state or whether `intervalMs` is set. Each message triggers one tick.

The two trigger types (scheduled tick vs. chat message) describe how the LLM prompt is assembled, not what kind of agent it is. The same agent can do both.

### TickQueue — single-worker FIFO

A single in-process `TickQueue` serializes all tick execution (scheduled + chat) across the whole process. One worker drains the queue:

- **Scheduled ticks** — orchestrator enqueues a task per due agent and bumps `lastTickAt` optimistically so subsequent looper iterations don't pile up duplicates.
- **Chat POSTs** — `POST /agents/:id/messages` always succeeds. Clients see SSE events `queued` (when not first), then `started`, then `token` / `tool_call` / `tool_result` / `done` / `error` as the task runs.

The current implementation is `InMemoryTickQueue` — single-process only, lost on restart. The `TickQueue` interface is shaped for swap-in alternatives (file-based, Redis-backed) without changing consumer code. Run `MODE=both` so the looper and server share the same queue instance.

### Migrating an existing DB

The agent shape changed: `type`, `enabled`, and `lastMessageAt` fields are dropped; `enabled` is now `running`. There is no in-place migration — wipe and re-seed:

```bash
npm run reset-db          # preserves zerog-bootstrap.json
npm run seed-agent        # re-install canonical agent
```

### Frontend SDK generation

```bash
# in the FE repo:
npm install -D openapi-typescript
npm install openapi-fetch
curl -o openapi.json http://localhost:3000/openapi.json
npx openapi-typescript openapi.json -o src/api-types.ts
```

Use `openapi-fetch<paths>` for typed requests. Chat SSE is hand-written (`fetch` + `ReadableStream` reader; the chat endpoint is `POST` so `EventSource` doesn't apply directly).

## Layout

```
src/
  agent-looper/  agent-runner/  agent-activity-log/
  ai/{zerog-broker, chat-model}/  ai-tools/
  uniswap/  wallet/{real, dry-run, factory}/
  providers/  database/  constants/  config/
scripts/         operator commands (anything that spends money)
```
