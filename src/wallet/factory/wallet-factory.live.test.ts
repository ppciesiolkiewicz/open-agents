import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletFactory } from './wallet-factory';
import { RealWallet } from '../real/real-wallet';
import { DryRunWallet } from '../dry-run/dry-run-wallet';
import { FileTransactionRepository } from '../../database/file-database/file-transaction-repository';
import type { AgentConfig } from '../../database/types';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = {
  WALLET_PRIVATE_KEY: TEST_KEY,
  ALCHEMY_API_KEY: 'unused-for-this-test',
};

function makeAgent(id: string, dryRun: boolean): AgentConfig {
  return {
    id,
    name: id,
    type: 'scheduled',
    enabled: true,
    intervalMs: 60_000,
    prompt: 'test',
    walletAddress: '',
    dryRun,
    dryRunSeedBalances: dryRun ? { native: '0' } : undefined,
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

describe('WalletFactory (live)', () => {
  let dbDir: string;
  let txRepo: FileTransactionRepository;
  let factory: WalletFactory;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-factory-'));
    txRepo = new FileTransactionRepository(dbDir);
    factory = new WalletFactory(TEST_ENV, txRepo);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
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
