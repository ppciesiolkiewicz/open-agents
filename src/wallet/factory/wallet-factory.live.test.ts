import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { WalletFactory } from './wallet-factory';
import { RealWallet } from '../real/real-wallet';
import { DryRunWallet } from '../dry-run/dry-run-wallet';
import { PrismaTransactionRepository } from '../../database/prisma-database/prisma-transaction-repository';
import { getTestPrisma, truncateAll } from '../../database/prisma-database/test-helpers';
import type { AgentConfig } from '../../database/types';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = {
  WALLET_PRIVATE_KEY: TEST_KEY,
  ALCHEMY_API_KEY: 'unused-for-this-test',
};

function makeAgent(id: string, dryRun: boolean): AgentConfig {
  return {
    id,
    userId: 'user-test',
    name: id,
    running: true,
    intervalMs: 60_000,
    prompt: 'test',
    dryRun,
    dryRunSeedBalances: dryRun ? { native: '0' } : undefined,
    allowedTokens: [],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

describe('WalletFactory (live)', () => {
  const prisma = getTestPrisma();
  let txRepo: PrismaTransactionRepository;
  let factory: WalletFactory;

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    txRepo = new PrismaTransactionRepository(prisma);
    factory = new WalletFactory(TEST_ENV, txRepo);
  });

  it('returns DryRunWallet for an agent with dryRun=true', () => {
    const w = factory.forAgent(makeAgent('a1', true));
    console.log('[wallet-factory] dry-run agent → wallet kind:', w.constructor.name);
    expect(w).toBeInstanceOf(DryRunWallet);
  });

  it('returns RealWallet for an agent with dryRun=false', () => {
    const w = factory.forAgent(makeAgent('a2', false));
    console.log('[wallet-factory] real agent → wallet kind:', w.constructor.name);
    expect(w).toBeInstanceOf(RealWallet);
  });

  it('both wallet kinds expose the same address derived from WALLET_PRIVATE_KEY', () => {
    const dry = factory.forAgent(makeAgent('a1', true));
    const real = factory.forAgent(makeAgent('a2', false));
    expect(dry.getAddress()).toBe(real.getAddress());
  });

  it('caches one wallet per agent id (same instance on repeat calls)', () => {
    const a1First = factory.forAgent(makeAgent('a1', true));
    const a1Second = factory.forAgent(makeAgent('a1', true));
    const a2 = factory.forAgent(makeAgent('a2', true));
    expect(a1First).toBe(a1Second);     // same reference
    expect(a1First).not.toBe(a2);       // different agent → different wallet
    console.log('[wallet-factory] cache reuse OK for a1');
  });
});
