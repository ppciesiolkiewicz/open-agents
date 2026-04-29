import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrismaClient } from '@prisma/client';
import { createPublicClient, http } from 'viem';
import { PrivyServerWallet } from './privy-server-wallet';
import { WalletProvisioner } from './wallet-provisioner';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { truncateAll } from '../../database/prisma-database/test-helpers';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const ALCHEMY = process.env.ALCHEMY_API_KEY;

describe.skipIf(!APP_ID || !APP_SECRET || !TEST_DB_URL || !ALCHEMY)('PrivyServerWallet (live, read-only)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL! } } });
  const privy = new PrivyClient(APP_ID!, APP_SECRET!);
  const users = new PrismaUserRepository(prisma);
  const userWallets = new PrismaUserWalletRepository(prisma);
  const provisioner = new WalletProvisioner(privy, userWallets);
  const publicClient = createPublicClient({
    transport: http(`https://unichain-mainnet.g.alchemy.com/v2/${ALCHEMY}`),
  });

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('getAddress returns the UserWallet.walletAddress', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    const wallet = new PrivyServerWallet(privy, uw, publicClient);
    expect(wallet.getAddress()).toBe(uw.walletAddress);
  });

  it('getNativeBalance reads on-chain balance via viem (returns >= 0n)', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    const wallet = new PrivyServerWallet(privy, uw, publicClient);
    const balance = await wallet.getNativeBalance();
    expect(balance).toBeGreaterThanOrEqual(0n);
    console.log('[privy-server-wallet] balance:', balance.toString());
  });
});
