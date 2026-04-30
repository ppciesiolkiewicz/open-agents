import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { confirmContinue } from '../src/test-lib/interactive-prompt';
import { buildSeedAgentConfig, SEED_AGENT_ID } from '../scripts/lib/seed-uni-ma-trader';
import { PrismaAgentRepository } from '../src/database/prisma-database/prisma-agent-repository';
import { PrismaUserRepository } from '../src/database/prisma-database/prisma-user-repository';

const DEV_USER_DID = 'did:privy:dev-local';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const users = new PrismaUserRepository(prisma);
    const agents = new PrismaAgentRepository(prisma);

    const unichainTokens = [
      {
        chainId: 130,
        chain: 'unichain',
        address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        logoUri: null,
      },
      {
        chainId: 130,
        chain: 'unichain',
        address: '0x8f187aA05619a017077f5308904739877ce9eA21',
        symbol: 'UNI',
        name: 'Uniswap',
        decimals: 18,
        logoUri: null,
      },
    ];

    for (const t of unichainTokens) {
      await prisma.token.upsert({
        where: { address_chainId: { address: t.address, chainId: t.chainId } },
        update: {
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          chain: t.chain,
          logoUri: t.logoUri,
        },
        create: t,
      });
    }
    console.log(`[seed] upserted ${unichainTokens.length} Unichain tokens`);

    const existing = await agents.findById(SEED_AGENT_ID);
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

    const devUser = await users.findOrCreateByPrivyDid(DEV_USER_DID, { email: 'dev@local' });
    console.log(`[seed] dev user: ${devUser.id} (${DEV_USER_DID})`);

    const seed = buildSeedAgentConfig({ dryRun, userId: devUser.id });
    await agents.upsert(seed);

    console.log(`[seed] installed agent "${seed.id}" (dryRun=${dryRun}) for user ${devUser.id}.`);
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
