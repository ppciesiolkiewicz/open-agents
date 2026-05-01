import { PrismaClient } from '@prisma/client';

let cached: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required to run live DB tests');
  if (!cached) {
    cached = new PrismaClient({ datasources: { db: { url } } });
  }
  return cached;
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ActivityEvent",
      "MemoryEntry",
      "AgentMemory",
      "Position",
      "Transaction",
      "AxlChannelMembership",
      "AxlChannel",
      "Agent",
      "UserWallet",
      "User"
    RESTART IDENTITY CASCADE
  `);
}
