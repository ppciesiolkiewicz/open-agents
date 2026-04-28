import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { confirmContinue } from '../src/test-lib/interactive-prompt';
import { buildSeedAgentConfig, SEED_AGENT_ID } from '../scripts/lib/seed-uni-ma-trader';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const repo = new PrismaAgentRepository(prisma);
    const existing = await repo.findById(SEED_AGENT_ID);
    if (existing) {
      console.error(`[seed] agent id "${SEED_AGENT_ID}" already exists in DB.`);
      console.error(`[seed] v1 supports only a single seed agent. Run \`npm run db:reset\` to start fresh.`);
      process.exit(1);
    }

    const realMode = process.argv.includes('--real');
    const dryRun = !realMode;

    const modeLabel = dryRun
      ? 'DRY-RUN (synthetic swaps, simulated balances, no real funds)'
      : 'REAL ONCHAIN (every swap signs + broadcasts a real tx; agent will spend gas + tokens from your wallet)';

    const ok = await confirmContinue(
      `Install UNI MA trader seed agent into Postgres? Mode: ${modeLabel}`,
    );
    if (!ok) {
      console.log('[seed] cancelled.');
      return;
    }

    const seed = buildSeedAgentConfig({ dryRun });
    await repo.upsert(seed);

    console.log(`[seed] installed agent "${seed.id}" (dryRun=${dryRun}).`);
    if (!dryRun) {
      console.log(`[seed] WARNING: real-onchain mode. Make sure the wallet has UNI/USDC + gas before running \`npm start\`.`);
    }
    console.log(`[seed] next: \`npm start\` to run the loop.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] fatal:', err);
  process.exit(1);
});
