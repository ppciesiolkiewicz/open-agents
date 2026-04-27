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
  const realMode = process.argv.includes('--real');
  const dryRun = !realMode;

  const db = await readDb();
  const existing = db.agents.find((a) => a.id === SEED_AGENT_ID);
  if (existing) {
    console.error(`[seed-agent] agent id "${SEED_AGENT_ID}" already exists in ${dbPath}.`);
    console.error(`[seed-agent] v1 supports only a single seed agent. Run \`npm run reset-db\` to start fresh.`);
    process.exit(1);
  }

  const modeLabel = dryRun
    ? 'DRY-RUN (synthetic swaps, simulated balances, no real funds)'
    : 'REAL ONCHAIN (every swap signs + broadcasts a real tx; agent will spend gas + tokens from your wallet)';
  const ok = await confirmContinue(
    `Install UNI MA trader seed agent into ${dbPath}? Mode: ${modeLabel}`,
  );
  if (!ok) {
    console.log('[seed-agent] cancelled.');
    return;
  }

  const seed = buildSeedAgentConfig({ dryRun });
  db.agents.push(seed);
  await writeDb(db);

  console.log(`[seed-agent] installed agent "${seed.id}" into ${dbPath} (dryRun=${dryRun}).`);
  console.log(`[seed-agent] total agents in db: ${db.agents.length}.`);
  if (!dryRun) {
    console.log(`[seed-agent] WARNING: real-onchain mode. Make sure the wallet has UNI/USDC + gas before running \`npm start\`.`);
  }
  console.log(`[seed-agent] next: \`npm start\` to run the loop. Watch \`${dbDir}/activity-log/${seed.id}.json\` for tick-by-tick activity.`);
}

main().catch((err) => {
  console.error('[seed-agent] fatal:', err);
  process.exit(1);
});
