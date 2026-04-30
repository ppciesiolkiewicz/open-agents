import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaTokenRepository } from './prisma-token-repository';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../../constants';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for live DB tests');
}

const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
const repo = new PrismaTokenRepository(prisma);

const UNICHAIN = 130;

beforeAll(async () => {
  await prisma.token.deleteMany({ where: { chainId: UNICHAIN } });
  await prisma.token.createMany({
    data: [
      {
        chainId: UNICHAIN,
        chain: 'unichain',
        address: USDC_ON_UNICHAIN.address.toLowerCase(),
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        coingeckoId: 'usd-coin',
      },
      {
        chainId: UNICHAIN,
        chain: 'unichain',
        address: UNI_ON_UNICHAIN.address.toLowerCase(),
        symbol: 'UNI',
        name: 'Uniswap',
        decimals: 18,
        coingeckoId: 'uniswap',
      },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PrismaTokenRepository (live)', () => {
  it('findByAddress lowercases input and returns token', async () => {
    const t = await repo.findByAddress(USDC_ON_UNICHAIN.address.toUpperCase(), UNICHAIN);
    expect(t).not.toBeNull();
    expect(t!.symbol).toBe('USDC');
    expect(t!.address).toBe(USDC_ON_UNICHAIN.address.toLowerCase());
    expect(t!.coingeckoId).toBe('usd-coin');
    console.log('findByAddress result:', t);
  });

  it('findByAddress returns null for unknown address', async () => {
    const t = await repo.findByAddress('0x0000000000000000000000000000000000000000', UNICHAIN);
    expect(t).toBeNull();
  });

  it('findManyByAddresses returns all known, drops unknown', async () => {
    const result = await repo.findManyByAddresses(
      [USDC_ON_UNICHAIN.address, UNI_ON_UNICHAIN.address, '0xDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEF'],
      UNICHAIN,
    );
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.symbol).sort()).toEqual(['UNI', 'USDC']);
  });

  it('findBySymbol returns all matches', async () => {
    const result = await repo.findBySymbol('USDC', UNICHAIN);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((t) => t.symbol === 'USDC')).toBe(true);
  });

  it('list paginates with cursor', async () => {
    const page1 = await repo.list({ chainId: UNICHAIN, limit: 1 });
    expect(page1.tokens).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await repo.list({ chainId: UNICHAIN, limit: 1, cursor: page1.nextCursor! });
    expect(page2.tokens).toHaveLength(1);
    const t1 = page1.tokens[0]!;
    const t2 = page2.tokens[0]!;
    expect(t2.id).not.toBe(t1.id);
  });

  it('list with search matches symbol and name (case-insensitive)', async () => {
    const r = await repo.list({ chainId: UNICHAIN, search: 'usd', limit: 50 });
    expect(r.tokens.some((t) => t.symbol === 'USDC')).toBe(true);
  });
});
