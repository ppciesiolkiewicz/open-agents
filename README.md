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

## Layout

```
src/
  agent-looper/  agent-runner/  agent-activity-log/
  ai/{zerog-broker, chat-model}/  ai-tools/
  uniswap/  wallet/{real, dry-run, factory}/
  providers/  database/  constants/  config/
scripts/         operator commands (anything that spends money)
```
