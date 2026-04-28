import { PrismaClient } from '@prisma/client';
import { describe } from 'vitest';

let cached: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient | null {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
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
      "Agent",
      "UserWallet",
      "User"
    RESTART IDENTITY CASCADE
  `);
}

export function describeIfPostgres(name: string, fn: () => void): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.log(`[skip] ${name} — TEST_DATABASE_URL not set`);
    return;
  }
  describe(name, fn);
}
