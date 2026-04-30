import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PrismaTokenRepository } from '../../database/prisma-database/prisma-token-repository';
import { buildTokensRouter } from './tokens';
import type { Database } from '../../database/database';
import { USDC_ON_UNICHAIN } from '../../constants';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must be set');

const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
const repo = new PrismaTokenRepository(prisma);
const db = { tokens: repo } as unknown as Database;

const app = express();
app.use('/tokens', buildTokensRouter({ db }));

beforeAll(async () => {
  await prisma.token.deleteMany({ where: { chainId: 130 } });
  await prisma.token.create({
    data: {
      chainId: 130,
      chain: 'unichain',
      address: USDC_ON_UNICHAIN.address.toLowerCase(),
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /tokens (live)', () => {
  it('lists tokens with default limit', async () => {
    const r = await supertest(app).get('/tokens?chainId=130&limit=50');
    expect(r.status).toBe(200);
    expect(r.body.tokens.length).toBeGreaterThan(0);
    expect(r.body.tokens[0]).toMatchObject({
      address: expect.any(String),
      symbol: expect.any(String),
      decimals: expect.any(Number),
    });
    console.log('GET /tokens body sample:', r.body.tokens[0]);
  });

  it('filters by symbol', async () => {
    const r = await supertest(app).get('/tokens?chainId=130&symbol=USDC');
    expect(r.status).toBe(200);
    expect(r.body.tokens.every((t: { symbol: string }) => t.symbol === 'USDC')).toBe(true);
  });
});
