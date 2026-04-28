# Postgres + Prisma Migration — Design

**Date:** 2026-04-28
**Status:** Brainstorming phase
**Scope:** Replace `FileDatabase` and `FileActivityLogStore` with a single Prisma + Postgres implementation. Add Docker Compose for local Postgres. Add npm scripts for DB lifecycle (up, down, migrate, seed, reset, studio). Production target later: Supabase. The `Database` interface, repository interfaces, and domain types remain unchanged in shape (one new field added: `Database.activityLog`).

## Goal

Move every queryable storage concern in the project to Postgres so:

- Activity log gains paginated, indexed reads (foundation for the upcoming UI).
- Cross-entity queries (positions joined to opening/closing transactions, etc.) are SQL, not in-memory JSON walks.
- Production parity is real: dev uses Postgres 16 in Docker, prod will use Supabase Postgres. No SQLite middle step.
- Future multi-user work (separate spec) lands on a relational schema instead of growing a file format.

`AgentRunner`, `AgentOrchestrator`, `WalletFactory`, `AgentActivityLog` (the high-level facade), and the `Looper` are reused unchanged in shape. Only the storage layer is rewritten.

## Non-Goals (v1)

- **Users / multi-tenancy.** No `User` table, no `Agent.userId` FK. Separate spec.
- **Data migration from `db/database.json`.** Local data is dev-only. Reset and re-seed.
- **`zerog-bootstrap.json` migration.** Stays as a file in `db/`. Deferred to a later spec; the file is a paid asset (3 OG to recreate) and a singleton, so it gets its own migration cycle.
- **CI Postgres.** Vitest live tests skip when `TEST_DATABASE_URL` is missing. Wiring Postgres into GitHub Actions is future work.
- **pgvector / similarity search.** `MemoryEntry.embedding` is dropped from v1 schema; added in a later migration when similarity search lands.
- **Connection pooling tuning, read replicas, partitioning.** Single `PrismaClient` per process.
- **Backups / disaster recovery.** Local volume only.

## Decisions

### D1. `agent-activity-log/` folds into `src/database/`

When activity log was file-backed it had a different storage shape (one JSON-array file per agent) than the structured `database.json`, justifying a separate module with its own `ActivityLogStore` abstraction. With both backed by the same Prisma client over the same Postgres instance, that separation no longer carries weight.

- `ActivityLogStore` becomes `ActivityLogRepository` and joins the `Database` facade (`database.activityLog`).
- The high-level `AgentActivityLog` facade (EventEmitter + typed write helpers like `tickStart`, `toolCall`, `llmResponse`) stays — it is a domain-level consumer, not storage — and moves to `src/database/agent-activity-log.ts`.
- The `src/agent-activity-log/` directory is deleted; all imports rewritten.
- The CLAUDE.md note about `database/` vs `agent-activity-log/` separation gets updated to reflect this consolidation.

### D2. Single Prisma implementation; `FileDatabase` deleted

`Database` interface, repository interfaces, and domain types stay. The `file-database/` directory and `file-activity-log-store.ts` are deleted along with their `*.live.test.ts` files. There is no `DB_BACKEND` env switch and no parallel implementation. CLAUDE.md already framed file storage as a v1 placeholder ("swap to SQLite/Postgres later = mechanical"); this is that swap.

### D3. Local Postgres via Docker Compose; production via Supabase

Local dev runs Postgres 16 in a Compose service. Production target is Supabase (managed Postgres 16). Same major version, same SQL surface. `prisma migrate deploy` runs unchanged against either.

`docker-compose.yml` declares one service (`postgres`) with two databases used by the project: `agent_loop` (dev) and `agent_loop_test` (live tests). The `POSTGRES_DB` env creates `agent_loop`; a `docker/postgres-init/01-create-test-db.sql` file mounted to `/docker-entrypoint-initdb.d/` creates `agent_loop_test` on first container start. (`db/` is gitignored data, so init scripts live under a new tracked `docker/postgres-init/` directory.)

### D4. Schema design

- **Repository interfaces and domain types do not change.** Mappers convert Prisma rows ↔ domain types inside `prisma-database/`.
- **bigints split by domain meaning:**
  - Token amounts and gas values (`TokenAmount.amountRaw`, `Transaction.gasUsed`, `gasPriceWei`, `gasCostWei`) → Postgres `TEXT`. These can exceed `int64`; CLAUDE.md mandates "bigints serialized as strings in all JSON".
  - Unix epoch timestamps (`createdAt`, `updatedAt`, `timestamp`, `openedAt`, `closedAt`, `lastTickAt`, `blockNumber`) → Postgres `BIGINT`. JS `number` covers ms-epoch comfortably until year 287396; Prisma exposes them as JS `bigint`, mapper converts to `number` at the domain boundary.
- **Embedded value objects → JSONB:** `Transaction.tokenIn`, `Transaction.tokenOut`, `Position.amount` (each a `TokenAmount`), `AgentConfig.riskLimits`, `AgentConfig.dryRunSeedBalances`, `AgentMemory.state`. None require independent SQL queries.
- **Append-only entries → relational tables.** `MemoryEntry` and `ActivityEvent` get their own tables with `(agentId, createdAt)` / `(agentId, timestamp)` indexes plus `(agentId, tickId)` indexes. Read patterns: filter by agent, paginate by time, group by tick.
- **IDs.** Domain generates UUIDs via `crypto.randomUUID()` (existing pattern). Prisma stores as `String @id`. No `@default(cuid())`.

### D5. Schema (Prisma)

```prisma
model Agent {
  id                  String   @id
  name                String
  prompt              String
  walletAddress       String
  dryRun              Boolean
  dryRunSeedBalances  Json?
  riskLimits          Json
  createdAt           BigInt
  running             Boolean?
  intervalMs          Int?
  lastTickAt          BigInt?

  transactions        Transaction[]
  positions           Position[]
  memory              AgentMemory?
  events              ActivityEvent[]
}

model Transaction {
  id            String   @id
  agentId       String
  agent         Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  hash          String
  chainId       Int
  from          String
  to            String
  tokenIn       Json?
  tokenOut      Json?
  gasUsed       String
  gasPriceWei   String
  gasCostWei    String
  status        String
  blockNumber   BigInt?
  timestamp     BigInt

  @@index([agentId, timestamp])
}

model Position {
  id                       String    @id
  agentId                  String
  agent                    Agent     @relation(fields: [agentId], references: [id], onDelete: Cascade)
  amount                   Json
  costBasisUSD             Float
  openedByTransactionId    String
  closedByTransactionId    String?
  openedAt                 BigInt
  closedAt                 BigInt?
  realizedPnlUSD           Float?

  @@index([agentId, closedAt])
}

model AgentMemory {
  agentId     String        @id
  agent       Agent         @relation(fields: [agentId], references: [id], onDelete: Cascade)
  notes       String        @default("")
  state       Json
  updatedAt   BigInt

  entries     MemoryEntry[]
}

model MemoryEntry {
  id              String      @id
  agentId         String
  memory          AgentMemory @relation(fields: [agentId], references: [agentId], onDelete: Cascade)
  tickId          String
  type            String
  content         String
  parentEntryIds  String[]
  createdAt       BigInt

  @@index([agentId, createdAt])
  @@index([agentId, tickId])
}

model ActivityEvent {
  id          String   @id
  agentId     String
  agent       Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  tickId      String?
  type        String
  level       String
  payload     Json
  timestamp   BigInt
  seq         BigInt   @default(autoincrement())

  @@index([agentId, timestamp])
  @@index([agentId, tickId])
  @@index([agentId, seq])
}
```

`ActivityEvent.seq` is the autoincrement column that today's `AgentActivityLogEntry.seq` returns from the file store. Listing by agent orders by `seq` ascending, matching the existing `AgentActivityLog.list` contract.

### D6. Test isolation: dedicated test database

Live tests target `TEST_DATABASE_URL`, a separate database (`agent_loop_test`) on the same Postgres instance. Vitest setup runs `prisma migrate deploy` once against the test DB; each test truncates all tables `CASCADE` in `beforeEach` to start clean. Dev data in `agent_loop` is never touched.

Tests skip themselves when `TEST_DATABASE_URL` is missing (mirrors the existing skip-when-key-missing pattern). `npm test` stays safe to run frequently — no Postgres available means tests skip, not fail.

### D7. Seed lives in `prisma/seed.ts`, not `scripts/`

`prisma/seed.ts` replaces `scripts/seed-agent.ts`. It imports `buildSeedAgentConfig` from `scripts/lib/seed-uni-ma-trader.ts` (kept; it's the source of truth for the seed agent shape) and inserts via Prisma. Same `confirmContinue` y/n prompt, same `--real` flag, same single-agent guard. `prisma migrate reset` runs it automatically via the `package.json` → `prisma.seed` config.

`scripts/seed-agent.ts` is deleted. `scripts/reset-db.ts` is deleted (DB reset goes through `npm run db:reset`; zerog-bootstrap reset stays manual until a later spec).

### D8. npm scripts

Added:

```jsonc
{
  "db:up":             "docker compose up -d postgres",
  "db:down":           "docker compose down",
  "db:nuke":           "docker compose down -v",
  "db:logs":           "docker compose logs -f postgres",
  "db:migrate":        "prisma migrate dev",
  "db:migrate:deploy": "prisma migrate deploy",
  "db:generate":       "prisma generate",
  "db:studio":         "prisma studio",
  "db:reset":          "prisma migrate reset",
  "db:seed":           "tsx prisma/seed.ts"
}
```

Removed: `seed-agent`, `reset-db`.

`package.json` gains:
```jsonc
"prisma": { "seed": "tsx prisma/seed.ts" }
```

### D9. Config

`config/` zod schema gains `DATABASE_URL` (required) and `TEST_DATABASE_URL` (optional; tests skip when absent). `.env.example` updated. No other env changes.

`PrismaClient` is constructed once at process boot in `src/index.ts` and passed to `new PrismaDatabase(prisma)`. The same instance flows through `AgentOrchestrator`, `AgentRunner`, etc. as today via the existing `Database` injection.

## Data Flow

Unchanged at every layer above storage. Domain code reads and writes through the same repository methods it does today; the only difference is the implementation.

```
AgentRunner / AgentOrchestrator / API server
   ↓ (Database facade)
PrismaDatabase
   ↓
PrismaAgentRepository / PrismaTransactionRepository / ... / PrismaActivityLogRepository
   ↓ (mappers convert rows ↔ domain types)
PrismaClient
   ↓
Postgres 16 (Docker locally; Supabase later)
```

`AgentActivityLog` (the EventEmitter facade) wraps `database.activityLog` and continues to emit live events for SSE consumers in the API server.

## File Layout

```
prisma/
  schema.prisma
  migrations/
  seed.ts                                       ← new; replaces scripts/seed-agent.ts logic

src/database/
  database.ts                                   ← interface; gains `activityLog`
  types.ts                                      ← domain types incl. AgentActivityLogEntry
  agent-activity-log.ts                         ← moved from src/agent-activity-log/
  repositories/
    agent-repository.ts
    transaction-repository.ts
    position-repository.ts
    agent-memory-repository.ts
    activity-log-repository.ts                  ← renamed from activity-log-store.ts
  prisma-database/
    prisma-database.ts
    prisma-agent-repository.ts
    prisma-transaction-repository.ts
    prisma-position-repository.ts
    prisma-agent-memory-repository.ts
    prisma-activity-log-repository.ts
    mappers.ts
    prisma-database.live.test.ts
    prisma-activity-log-repository.live.test.ts

docker-compose.yml                              ← new
docker/postgres-init/
  01-create-test-db.sql                         ← new; creates agent_loop_test on first boot
.env.example                                    ← gains DATABASE_URL, TEST_DATABASE_URL

# Deleted
src/database/file-database/                     ← entire directory
src/agent-activity-log/                         ← entire directory
scripts/seed-agent.ts
scripts/reset-db.ts
```

`scripts/lib/seed-uni-ma-trader.ts` stays — `prisma/seed.ts` imports it.

## Onboarding & Reset Sequences

**First-time setup:**
```
npm install
npm run db:up
npm run db:migrate         # creates schema + applies first migration
npm run db:seed            # installs UNI MA trader (prompts y/n)
npm start
```

**Routine reset (wipes data, re-applies migrations, re-seeds):**
```
npm run db:reset
```

**Full nuke (drops volume, rebuilds):**
```
npm run db:nuke && npm run db:up && npm run db:migrate
```

**Production deploy (Supabase, future spec):**
```
DATABASE_URL=<supabase_url> npm run db:migrate:deploy
```

## Testing

- `prisma-database.live.test.ts` — round-trip every repository (agents, transactions, positions, agent-memory) against `TEST_DATABASE_URL`. Truncate all tables `CASCADE` in `beforeEach`.
- `prisma-activity-log-repository.live.test.ts` — append, listByAgent, ordering by `seq`, `sinceTickId` filtering, `limit` pagination.
- All tests skip when `TEST_DATABASE_URL` is missing.
- `npm test` runs them when the env var is set; otherwise prints a skip message.
- `*.live.test.ts` style is preserved (sensible assertions + `console.log` payloads for human eyeballing per CLAUDE.md).

## Open Items

- **`zerog-bootstrap.json` move to Postgres** — separate spec. Singleton row, possibly `KeyValue` table or its own `ZerogBootstrap` table. Care needed because the on-chain account creation costs OG.
- **Users + multi-tenancy** — separate spec. Adds `User`, `Agent.userId`, ownership checks throughout the API.
- **pgvector + `MemoryEntry.embedding`** — separate spec when similarity search lands. Requires enabling the `vector` extension and a follow-up migration adding the column.
- **CI** — wire Postgres into GitHub Actions so live tests run there.
- **Connection pooling for Supabase** — Supabase requires `pgbouncer`-style pooling for serverless workloads; a future deploy spec covers connection string format and `prisma generate --no-engine` if Prisma Accelerate is used.
