import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrismaClient } from '@prisma/client';
import { createPublicClient, http } from 'viem';
import { PrivyWalletFactory } from './privy-wallet-factory';
import { WalletProvisioner } from './wallet-provisioner';
import { PrivyServerWallet } from './privy-server-wallet';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { truncateAll } from '../../database/prisma-database/test-helpers';

describe('PrivyWalletFactory (live)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const privy = new PrivyClient(process.env.PRIVY_APP_ID!, process.env.PRIVY_APP_SECRET!);
  const users = new PrismaUserRepository(prisma);
  const userWallets = new PrismaUserWalletRepository(prisma);
  const provisioner = new WalletProvisioner(privy, userWallets);
  const publicClient = createPublicClient({
    transport: http(`https://unichain-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
  });
  const factory = new PrivyWalletFactory(privy, publicClient);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('forUserWallet returns a PrivyServerWallet whose address matches the row', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    const wallet = factory.forUserWallet(uw);
    expect(wallet).toBeInstanceOf(PrivyServerWallet);
    expect(wallet.getAddress()).toBe(uw.walletAddress);
  });
});
