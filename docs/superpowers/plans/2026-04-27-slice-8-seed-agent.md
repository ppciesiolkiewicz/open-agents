# Slice 8 — Seed agent (UNI MA trader, end-to-end dry-run)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the canonical seed agent — a UNI/USDC moving-average trader that runs end-to-end on the framework. Operator runs `npm run seed-agent` once; with a funded 0G provider already configured, `npm start` then drives the full loop (looper → orchestrator → runner → tools → DryRunWallet → Position) on the live LLM. This is the final spec slice; after it the project is a working v1.

**Architecture:** Configuration + scripts only. No `src/` changes. The seed `AgentConfig` lives as TypeScript source of truth in `scripts/lib/`, installed into `db/database.json` by `scripts/seed-agent.ts`. A companion `scripts/reset-db.ts` wipes ephemeral state for fresh runs. The agent runs in `dryRun: true` so every swap goes through `DryRunWallet` (sentinel-hash transaction + balance replay against seed); no real funds move. The MA strategy uses tight 3-tick / 7-tick windows aggressive enough that 1-minute ticks produce visible signals within ~10 minutes of starting.

**Tech Stack:** Node 20+, TypeScript, tsx (already wired), `confirmContinue` from `src/test-lib/interactive-prompt.ts`, no new deps.

**Spec reference:** [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](../specs/2026-04-26-agent-loop-foundation-design.md) — section "Seed Agent".

**Test rule (slice 8):**
- No new `*.live.test.ts` files. The seed config is verified end-to-end by running `npm start` after `npm run seed-agent` (operator smoke).
- The scripts themselves get pure unit smoke (typecheck pass + a dry-run invocation that exits cleanly when the user declines confirmation).

---

## File Structure

```
scripts/
  lib/
    seed-uni-ma-trader.ts                 # NEW — exports the canonical seed AgentConfig
  seed-agent.ts                           # NEW — installs seed into db/database.json (fails if id exists)
  reset-db.ts                             # NEW — wipes ephemeral db state (preserves zerog-bootstrap.json by default)
package.json                              # MODIFY — add seed-agent + reset-db scripts
```

---

## Task 1: Seed config + `seed-agent` script

**Files:**
- Create: `scripts/lib/seed-uni-ma-trader.ts`
- Create: `scripts/seed-agent.ts`

The seed config uses tight 3/7 MA windows so signals fire within ~10 minutes of starting (10 ticks at 60s). Aggressive: 25% of USDC into UNI on every golden cross, 100% of UNI out on every death cross. The prompt gives an explicit step-by-step recipe so the LLM doesn't have to reason about workflow — only execute.

The script FAILS (exits non-zero) if an agent with the same id already exists in `db/database.json`. Multi-agent setups land in a future slice; v1 keeps a single-seed convention.

- [ ] **Step 1: Create `scripts/lib/seed-uni-ma-trader.ts`**

```ts
import { TOKENS } from '../../src/constants';
import type { AgentConfig } from '../../src/database/types';

export const SEED_AGENT_ID = 'uni-ma-trader-001';

const PROMPT = `You are a UNI/USDC moving-average trader on Unichain. Your goal is to grow your USDC balance by capturing short-term UNI price swings.

Every tick, do exactly:
1. Call fetchTokenPriceUSD with symbol="UNI" to get the current price (a number).
2. Call readMemory to load your current state.
3. Take state.priceHistory (default to []) and append the new price. Keep only the last 20 entries.
4. Call saveMemoryEntry with type="snapshot" and content="<price> at tick <state.tickCount + 1>".
5. If priceHistory has fewer than 7 entries, call updateMemory with the appended priceHistory + tickCount incremented + lastSignal preserved, and stop. Not enough data yet.
6. Compute shortMA = average of the last 3 prices, longMA = average of the last 7 prices.
7. Determine the signal:
   - If shortMA > longMA AND state.lastSignal !== "GOLDEN_CROSS" → signal = "GOLDEN_CROSS".
   - If shortMA < longMA AND state.lastSignal !== "DEATH_CROSS" → signal = "DEATH_CROSS".
   - Otherwise → signal = "HOLD".
8. Call getTokenBalance for tokenAddress="${TOKENS.USDC.address}" and tokenAddress="${TOKENS.UNI.address}" to know your holdings.
9. Act on the signal:
   - GOLDEN_CROSS AND USDC raw balance > 0: call executeUniswapSwapExactIn with tokenIn="USDC", tokenOut="UNI", amountIn=floor(USDC raw balance × 0.25) as a string, slippageBps=200.
   - DEATH_CROSS AND UNI raw balance > 0: call executeUniswapSwapExactIn with tokenIn="UNI", tokenOut="USDC", amountIn=full UNI raw balance as a string, slippageBps=200.
   - HOLD: do not swap.
10. Call updateMemory with state={priceHistory, shortMA, longMA, lastSignal: signal, tickCount: <prev + 1>}, appendNote = one short sentence summarizing the tick (price, MAs, signal, action).

Always pass amountIn as a string of base-units (no decimal scaling). USDC has 6 decimals, UNI has 18.`;

export function buildSeedAgentConfig(now: number = Date.now()): AgentConfig {
  return {
    id: SEED_AGENT_ID,
    name: 'UNI Moving Average Trader',
    enabled: true,
    intervalMs: 60_000,
    prompt: PROMPT,
    walletAddress: '',
    dryRun: true,
    dryRunSeedBalances: {
      native: '100000000000000000',                  // 0.1 ETH for gas (in wei)
      [TOKENS.USDC.address]: '1000000000',           // 1000 USDC (6 decimals)
      [TOKENS.UNI.address]: '0',
    },
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: now,
  };
}
```

- [ ] **Step 2: Create `scripts/seed-agent.ts`**

```ts
import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { confirmContinue } from '../src/test-lib/interactive-prompt';
import { buildSeedAgentConfig, SEED_AGENT_ID } from './lib/seed-uni-ma-trader';
import type { AgentConfig, Position, Transaction } from '../src/database/types';

interface DatabaseFile {
  agents: AgentConfig[];
  transactions: Transaction[];
  positions: Position[];
}

const dbDir = process.env.DB_DIR ?? './db';
const dbPath = join(dbDir, 'database.json');

async function readDb(): Promise<DatabaseFile> {
  try {
    const raw = await readFile(dbPath, 'utf8');
    return JSON.parse(raw) as DatabaseFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { agents: [], transactions: [], positions: [] };
    }
    throw err;
  }
}

async function writeDb(file: DatabaseFile): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(file, null, 2), 'utf8');
}

async function main(): Promise<void> {
  const db = await readDb();
  const existing = db.agents.find((a) => a.id === SEED_AGENT_ID);
  if (existing) {
    console.error(`[seed-agent] agent id "${SEED_AGENT_ID}" already exists in ${dbPath}.`);
    console.error(`[seed-agent] v1 supports only a single seed agent. Run \`npm run reset-db\` to start fresh.`);
    process.exit(1);
  }

  const ok = await confirmContinue(
    `Install UNI MA trader seed agent into ${dbPath}? (dryRun=true, 1000 USDC + 0.1 ETH seed, intervalMs=60s)`,
  );
  if (!ok) {
    console.log('[seed-agent] cancelled.');
    return;
  }

  const seed = buildSeedAgentConfig();
  db.agents.push(seed);
  await writeDb(db);

  console.log(`[seed-agent] installed agent "${seed.id}" into ${dbPath}.`);
  console.log(`[seed-agent] total agents in db: ${db.agents.length}.`);
  console.log(`[seed-agent] next: \`npm start\` to run the loop. Watch \`${dbDir}/activity-log/${seed.id}.json\` for tick-by-tick activity.`);
}

main().catch((err) => {
  console.error('[seed-agent] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0 (both configs).

- [ ] **Step 4: Smoke — script declines exit cleanly**

```bash
echo "n" | npm run seed-agent 2>&1 | head -10
```

Expected: prints the confirmation banner, prints "[seed-agent] cancelled.", exits 0. No `db/database.json` modification.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/seed-uni-ma-trader.ts scripts/seed-agent.ts
git commit -m "feat(scripts): add seed-agent (installs canonical UNI MA trader into db/database.json)"
```

---

## Task 2: `reset-db` script

**Files:**
- Create: `scripts/reset-db.ts`

Default: wipes `database.json`, `memory/`, `activity-log/`. Preserves `zerog-bootstrap.json` so the operator doesn't lose their funded provider state (~3 OG to re-fund). `--all` flag wipes everything including the bootstrap.

- [ ] **Step 1: Create `scripts/reset-db.ts`**

```ts
import 'dotenv/config';
import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { confirmContinue } from '../src/test-lib/interactive-prompt';

const dbDir = process.env.DB_DIR ?? './db';

const PRESERVE_BY_DEFAULT = ['zerog-bootstrap.json'];

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');

  const entries = await listDir(dbDir);
  if (entries.length === 0) {
    console.log(`[reset-db] ${dbDir} is already empty (or missing). Nothing to do.`);
    return;
  }

  const willDelete = all ? entries : entries.filter((e) => !PRESERVE_BY_DEFAULT.includes(e));
  const willKeep = all ? [] : entries.filter((e) => PRESERVE_BY_DEFAULT.includes(e));

  if (willDelete.length === 0) {
    console.log(`[reset-db] only protected files present (${willKeep.join(', ')}). Pass --all to wipe everything.`);
    return;
  }

  console.log(`[reset-db] in ${dbDir}:`);
  console.log(`  will delete: ${willDelete.join(', ')}`);
  if (willKeep.length > 0) console.log(`  will keep:   ${willKeep.join(', ')}`);
  if (all) console.log('  --all flag set: nothing preserved (you will need to re-fund 0G to use the LLM).');

  const ok = await confirmContinue(`Proceed with reset?`);
  if (!ok) {
    console.log('[reset-db] cancelled.');
    return;
  }

  for (const name of willDelete) {
    const target = join(dbDir, name);
    const info = await stat(target);
    await rm(target, { recursive: info.isDirectory(), force: true });
    console.log(`[reset-db] removed ${target}`);
  }
  console.log('[reset-db] done.');
}

main().catch((err) => {
  console.error('[reset-db] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Smoke — script declines cleanly**

```bash
echo "n" | npm run reset-db 2>&1 | head -10
```

Expected: prints the file list, confirmation banner, "[reset-db] cancelled.", exits 0. `db/` untouched.

- [ ] **Step 4: Commit**

```bash
git add scripts/reset-db.ts
git commit -m "feat(scripts): add reset-db (wipes ephemeral db state; preserves zerog-bootstrap.json by default; --all to wipe everything)"
```

---

## Task 3: Wire npm scripts + final sweep + tag

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json`**

Add to the `scripts` block:

```json
"seed-agent": "NODE_OPTIONS=--conditions=require tsx scripts/seed-agent.ts",
"reset-db": "NODE_OPTIONS=--conditions=require tsx scripts/reset-db.ts",
```

(Place them next to the existing `swap:*` and `llm:probe` lines for consistency.)

- [ ] **Step 2: Verify typecheck + tests**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: same baseline (81 pass, 1 known fail Firecrawl 402, 0 skipped).

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Verify directory structure**

Run: `find scripts -type f | sort`

Expected:
```
scripts/lib/seed-uni-ma-trader.ts
scripts/lib/swap-runner.ts
scripts/reset-db.ts
scripts/seed-agent.ts
scripts/swap-buy-uni.ts
scripts/swap-sell-uni.ts
scripts/zerog-llm-probe.ts
```

- [ ] **Step 5: Tag**

```bash
git tag slice-8-seed-agent
```

- [ ] **Step 6: Commit count**

Run: `git log --oneline slice-7-uniswap..HEAD`
Expected: 4 commits (Tasks 1, 2, 3 + the docs/plan commit).

- [ ] **Step 7: Commit the package.json change**

```bash
git add package.json
git commit -m "chore: wire seed-agent + reset-db npm scripts"
```

(Move the slice-8 tag to this commit if needed: `git tag -d slice-8-seed-agent && git tag slice-8-seed-agent`.)

---

## Operator Runbook (final v1 flow)

```bash
# One-time setup ─────────────────────────────────────────────
npm install                          # deps
# Configure .env with WALLET_PRIVATE_KEY, ALCHEMY_API_KEY, ZEROG_NETWORK, provider keys

npm run zerog-bootstrap              # list 0G providers; pick one
# Set ZEROG_PROVIDER_ADDRESS=0x... in .env, re-run to fund (~3 OG)

npm run llm:probe                    # tiny OG cost; sanity-check the LLM round-trip

npm run seed-agent                   # install UNI MA trader into db/database.json

# Run the loop ───────────────────────────────────────────────
npm start
# Watch:
#   db/activity-log/uni-ma-trader-001.json  ← tick-by-tick events
#   db/memory/uni-ma-trader-001.json        ← agent's evolving state
#   db/database.json                         ← agent config (lastTickAt updates), simulated swap txs, opened/closed positions

# Reset for a fresh run ──────────────────────────────────────
npm run reset-db                     # wipes everything except zerog-bootstrap.json
npm run reset-db -- --all            # wipes everything; you'll need to re-fund 0G
```

---

## Out of Scope for Slice 8

- Multi-agent setups (current `seed-agent` fails if the seed already exists)
- Strategy variants (different MA windows, position sizing, stop-loss) — operator edits the prompt or `dryRunSeedBalances` directly
- Real-trading mode (`dryRun: false` agents) — operator can flip the flag in `db/database.json` after seeding, but slice 8 does not provide a separate template
- A web UI for activity logs (the spec mentions logs are designed for later UI render — slice 9+)
- Automated price-history bootstrapping (the agent waits 7 ticks before its first MA computation)

---

## Self-Review

**Spec coverage check:**
- ✅ "Seed agent" — UNI MA trader, end-to-end dry-run — Task 1 (config + install script)
- ✅ Spec's `Seed Agent (db/database.json bootstrap)` JSON example — Task 1's `buildSeedAgentConfig` matches the shape with the locked decisions (1-min ticks, 25% sizing, 3/7 MA windows)
- ✅ `dryRun: true` so the framework never spends real funds — Task 1's seed
- ✅ End-to-end smoke documented in operator runbook — final section

**Placeholder scan:** No TBDs. Each step has actual code or exact commands.

**Type consistency:**
- `AgentConfig` from slice 2 used unchanged — Task 1
- `TOKENS` from slice 1 (with `coingeckoId` from slice 6 + `address` of `0x${string}` form) used in seed config — Task 1
- `confirmContinue` from `src/test-lib/interactive-prompt.ts` (slice 7) used in both scripts — Tasks 1, 2
- `Database` types (Position, Transaction) match slice 2 — Task 1's `DatabaseFile` interface
- Script env conventions match the existing scripts (`dotenv/config`, `DB_DIR`, NODE_OPTIONS for broker SDK ESM)
