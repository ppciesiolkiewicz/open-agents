# open-agents-agent-loop

TypeScript loop that fires AI agents on a schedule. Each agent gets an LLM-driven prompt with onchain (Uniswap v4 on Unichain) + offchain tools and persists every config, transaction, position, and tick to disk. Reference agent is a UNI/USDC moving-average trader.

## Setup

```bash
npm install
cp .env.example .env  # fill in keys (WALLET_PRIVATE_KEY, ALCHEMY_API_KEY, ZEROG_NETWORK, REDIS_URL, DATABASE_URL, etc.)
docker compose up -d postgres redis
npm run db:migrate
npm run db:seed
```

## Run

```bash
# 1. fund a 0G inference provider (one-time, ~3 OG)
npm run zerog-bootstrap          # lists providers
# set ZEROG_PROVIDER_ADDRESS=0x... in .env
npm run zerog-bootstrap          # this run actually funds + persists

# 2. run the two processes (separate terminals)
npm run start:worker
npm run start:server
```

## Scripts

| Command | What |
|---|---|
| `npm run start:worker` | scheduler + tick dispatcher process |
| `npm run start:server` | API + SSE process |
| `npm run dev:worker` / `npm run dev:server` | tsx watch mode |
| `npm test` / `npm run typecheck` / `npm run build` | dev loops; safe to run any time |
| `npm run zerog-bootstrap` | list / fund 0G inference provider |
| `npm run llm:probe` | sanity-check the LLM round trip |
| `npm run swap:buy-uni` / `npm run swap:sell-uni` | manual UNI/USDC swap on Unichain |
| `npm run db:up` / `db:down` / `db:nuke` | Postgres + Redis docker lifecycle |
| `npm run db:migrate` / `db:seed` / `db:reset` / `db:studio` | Prisma lifecycle |

Every fund-spending script prompts `[y/N]` before doing anything.

## Docs

- [CLAUDE.md](CLAUDE.md) — architecture decisions + coding standards
- [docs/superpowers/specs/](docs/superpowers/specs/) — design spec
- [docs/superpowers/plans/](docs/superpowers/plans/) — per-slice implementation plans

## Processes

The agent loop runs as **two independent processes** sharing Postgres + Redis:

```bash
npm run start:worker    # scheduler + tick dispatcher (no HTTP)
npm run start:server    # Express API + SSE (no scheduler)
```

Both processes can run on different machines / containers. Communication:

- **Postgres** — durable state (agents, transactions, positions, memory, activity log)
- **Redis LIST** (`agent-loop:queue`) — tick payloads enqueued by either process; consumed by worker via `BRPOP`
- **Redis pub/sub** (`agent-loop:activity:<agentId>`) — activity-log events published by the worker; subscribed by the server for SSE delivery

Either process can crash/restart without losing durable state. In-flight ticks consumed via `BRPOP` are not requeued on worker crash (at-most-once); chat messages can be retried by the client.

CORS allow-list via `API_CORS_ORIGINS` (CSV; omit for `*`). Privy creds (`PRIVY_APP_ID` + `PRIVY_APP_SECRET`) are required by the server only.

- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI 3.1 spec (consume from FE to generate SDK)
- `GET /agents`, `POST /agents`, `GET /agents/:id`, `PATCH /agents/:id`, `DELETE /agents/:id`
- `POST /agents/:id/start`, `POST /agents/:id/stop` — set `running = true/false` on any agent
- `GET /agents/:id/activity?cursor=&limit=&order=desc|asc` — paginated activity log
- `GET /agents/:id/messages?cursor=&limit=&order=desc|asc` — paginated chat history
- `POST /agents/:id/messages` — enqueue a chat task; returns `202 { position }` immediately. No SSE on this endpoint.
- `GET /agents/:id/stream` — SSE stream of all activity-log events for the agent. Each `data:` line is `{ type: "append", entry }` or `{ type: "ephemeral", payload }`. Subscribe before (or after) posting a message to observe the tick run. Multiple clients can subscribe simultaneously.

Auth is a stub in v1 (every request gets `user.id = 'local-dev'`). JWT decoding lands in the same middleware later; endpoint signatures stay the same.

### Unified agent model

There is no agent type discriminator. Every agent can:

- **Run on a schedule** — set `intervalMs >= 1000` and call `POST /agents/:id/start`. The orchestrator fires a scheduled tick whenever `running === true` and the interval has elapsed.
- **Accept chat messages** — call `POST /agents/:id/messages` at any time, regardless of `running` state or whether `intervalMs` is set. Each message triggers one tick.

The two trigger types (scheduled tick vs. chat message) describe how the LLM prompt is assembled, not what kind of agent it is. The same agent can do both.

### Tick queue — Redis-backed FIFO

A single Redis LIST (`agent-loop:queue`) serializes all tick execution (scheduled + chat) across the whole system. Both processes can enqueue:

- **Scheduled ticks** — the worker's orchestrator enqueues a payload per due agent and bumps `lastTickAt` optimistically so subsequent worker iterations don't pile up duplicates.
- **Chat POSTs** — `POST /agents/:id/messages` on the server enqueues a `chat` payload immediately and returns `202 { position }`.

The worker's `TickDispatcher` `BRPOP`s the list and runs payloads sequentially via `AgentRunner`.

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

Use `openapi-fetch<paths>` for typed requests. `/stream` is a standard SSE endpoint (`GET`), so `EventSource` applies directly: `new EventSource('/agents/<id>/stream')`. Parse each `event.data` as JSON to get `{ type, entry | payload }`.

## Layout

```
src/
  agent-worker/  agent-runner/  agent-activity-log/
  ai/{zerog-broker, chat-model}/  ai-tools/
  uniswap/  wallet/{real, dry-run, factory}/
  providers/  database/  redis/  constants/  config/
  worker.ts  server.ts
scripts/         operator commands (anything that spends money)
```
