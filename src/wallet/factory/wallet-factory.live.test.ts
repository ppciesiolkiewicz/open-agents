import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers';
import { createPublicClient, http, type PublicClient } from 'viem';
import { unichain } from 'viem/chains';
import { PrivyClient } from '@privy-io/server-auth';
import { WalletFactory } from './wallet-factory';
import { RealWallet } from '../real/real-wallet';
import { DryRunWallet } from '../dry-run/dry-run-wallet';
import { PrivyServerWallet } from '../privy/privy-server-wallet';
import { PrivySigner } from '../privy/privy-signer';
import { PrismaTransactionRepository } from '../../database/prisma-database/prisma-transaction-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { getTestPrisma, truncateAll } from '../../database/prisma-database/test-helpers';
import { ZEROG_NETWORKS } from '../../constants';
import type { AgentConfig, User, UserWallet } from '../../database/types';
import { randomUUID } from 'node:crypto';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = {
  WALLET_PRIVATE_KEY: TEST_KEY,
  ALCHEMY_API_KEY: 'unused-for-this-test',
};
const PUBLIC_CLIENT = createPublicClient({ chain: unichain, transport: http() }) as PublicClient;
const ZEROG_PROVIDER = new JsonRpcProvider(ZEROG_NETWORKS.testnet.rpcUrl);
const ZEROG_CHAIN_ID = ZEROG_NETWORKS.testnet.chainId;

function makeAgent(opts: { id: string; userId: string; dryRun: boolean }): AgentConfig {
  return {
    id: opts.id,
    userId: opts.userId,
    name: opts.id,
    running: true,
    intervalMs: 60_000,
    prompt: 'test',
    dryRun: opts.dryRun,
    dryRunSeedBalances: opts.dryRun ? { native: '0' } : undefined,
    allowedTokens: [],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

async function seedUserWithWallet(
  users: PrismaUserRepository,
  wallets: PrismaUserWalletRepository,
  privyDid: string,
): Promise<{ user: User; uw: UserWallet }> {
  const user = await users.findOrCreateByPrivyDid(privyDid, {});
  const uw: UserWallet = {
    id: randomUUID(),
    userId: user.id,
    privyWalletId: `privy-wallet-${user.id}`,
    walletAddress: `0x${'ab'.repeat(20)}`,
    isPrimary: true,
    createdAt: Date.now(),
  };
  await wallets.insert(uw);
  return { user, uw };
}

describe('WalletFactory (live)', () => {
  const prisma = getTestPrisma();
  let txRepo: PrismaTransactionRepository;
  let userWallets: PrismaUserWalletRepository;
  let users: PrismaUserRepository;

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    txRepo = new PrismaTransactionRepository(prisma);
    userWallets = new PrismaUserWalletRepository(prisma);
    users = new PrismaUserRepository(prisma);
  });

  function build(walletMode: 'pk' | 'privy' | 'privy_and_pk', privy: PrivyClient | null = null): WalletFactory {
    return new WalletFactory({
      env: TEST_ENV,
      walletMode,
      transactions: txRepo,
      userWallets,
      privy,
      publicClient: PUBLIC_CLIENT,
      zerogProvider: ZEROG_PROVIDER,
      zerogChainId: ZEROG_CHAIN_ID,
    });
  }

  describe('forAgent', () => {
    it('pk mode: returns RealWallet for live agent', async () => {
      const factory = build('pk');
      const w = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      expect(w).toBeInstanceOf(RealWallet);
    });

    it('any mode: returns DryRunWallet when agent.dryRun=true', async () => {
      const factory = build('privy', new PrivyClient('app-id', 'app-secret'));
      const w = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: true }));
      expect(w).toBeInstanceOf(DryRunWallet);
    });

    it('privy mode: returns PrivyServerWallet using primary UserWallet', async () => {
      const { user, uw } = await seedUserWithWallet(users, userWallets, 'did:privy:test');
      const privy = new PrivyClient('app-id-stub', 'app-secret-stub');
      const factory = build('privy', privy);
      const w = await factory.forAgent(makeAgent({ id: 'a1', userId: user.id, dryRun: false }));
      expect(w).toBeInstanceOf(PrivyServerWallet);
      expect(w.getAddress().toLowerCase()).toBe(uw.walletAddress.toLowerCase());
      console.log('[wallet-factory] privy → wallet address:', w.getAddress());
    });

    it('privy_and_pk mode: returns PrivyServerWallet for tools (same as privy)', async () => {
      const { user } = await seedUserWithWallet(users, userWallets, 'did:privy:test2');
      const privy = new PrivyClient('app-id-stub', 'app-secret-stub');
      const factory = build('privy_and_pk', privy);
      const w = await factory.forAgent(makeAgent({ id: 'a2', userId: user.id, dryRun: false }));
      expect(w).toBeInstanceOf(PrivyServerWallet);
    });

    it('privy mode: throws when agent.userId has no primary UserWallet', async () => {
      const privy = new PrivyClient('app-id-stub', 'app-secret-stub');
      const factory = build('privy', privy);
      await expect(
        factory.forAgent(makeAgent({ id: 'a1', userId: 'unknown-user', dryRun: false })),
      ).rejects.toThrow(/no primary UserWallet/);
    });

    it('privy mode: throws when no PrivyClient is provided', async () => {
      const factory = build('privy', null);
      await expect(
        factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false })),
      ).rejects.toThrow(/requires a PrivyClient/);
    });

    it('caches one wallet per agent id (same instance on repeat calls)', async () => {
      const factory = build('pk');
      const a1First = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      const a1Second = await factory.forAgent(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      const a2 = await factory.forAgent(makeAgent({ id: 'a2', userId: 'u1', dryRun: false }));
      expect(a1First).toBe(a1Second);
      expect(a1First).not.toBe(a2);
    });
  });

  describe('forZerogPayments', () => {
    it('pk mode: returns env-pk signer (singleton across calls)', async () => {
      const factory = build('pk');
      const a1 = await factory.forZerogPayments(makeAgent({ id: 'a1', userId: 'u1', dryRun: false }));
      const a2 = await factory.forZerogPayments(makeAgent({ id: 'a2', userId: 'u2', dryRun: false }));
      expect(a1).toBe(a2);
      expect(a1.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      console.log('[wallet-factory] pk zerog signer address:', a1.address);
    });

    it('privy_and_pk mode: returns env-pk signer (same singleton as pk)', async () => {
      const { user } = await seedUserWithWallet(users, userWallets, 'did:privy:t3');
      const factory = build('privy_and_pk', new PrivyClient('id', 'secret'));
      const handle = await factory.forZerogPayments(makeAgent({ id: 'a1', userId: user.id, dryRun: false }));
      const expected = new EthersWallet(TEST_KEY).address;
      expect(handle.address.toLowerCase()).toBe(expected.toLowerCase());
    });

    it('privy mode: returns PrivySigner for the user wallet, cached per-user', async () => {
      const { user, uw } = await seedUserWithWallet(users, userWallets, 'did:privy:t4');
      const privy = new PrivyClient('id', 'secret');
      const factory = build('privy', privy);
      const a1 = await factory.forZerogPayments(makeAgent({ id: 'a1', userId: user.id, dryRun: false }));
      const a2 = await factory.forZerogPayments(makeAgent({ id: 'a2', userId: user.id, dryRun: false }));
      expect(a1).toBe(a2);
      expect(a1.address.toLowerCase()).toBe(uw.walletAddress.toLowerCase());
      expect(a1.signer).toBeInstanceOf(PrivySigner);
    });

    it('privy mode: throws when user has no primary UserWallet', async () => {
      const factory = build('privy', new PrivyClient('id', 'secret'));
      await expect(
        factory.forZerogPayments(makeAgent({ id: 'a1', userId: 'unknown', dryRun: false })),
      ).rejects.toThrow(/no primary UserWallet/);
    });
  });
});
