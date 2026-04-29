import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrismaClient } from '@prisma/client';
import { WalletProvisioner } from './wallet-provisioner';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { PrismaUserRepository } from '../../database/prisma-database/prisma-user-repository';
import { truncateAll } from '../../database/prisma-database/test-helpers';

describe('WalletProvisioner (live)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const privy = new PrivyClient(process.env.PRIVY_APP_ID!, process.env.PRIVY_APP_SECRET!);
  const userWallets = new PrismaUserWalletRepository(prisma);
  const users = new PrismaUserRepository(prisma);
  const provisioner = new WalletProvisioner(privy, userWallets);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('provisionPrimary creates a Privy wallet + inserts UserWallet', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const uw = await provisioner.provisionPrimary(u.id);
    expect(uw.userId).toBe(u.id);
    expect(uw.privyWalletId).toBeTruthy();
    expect(uw.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(uw.isPrimary).toBe(true);
    console.log('[wallet-provisioner] created:', uw);
  });

  it('provisionPrimary is idempotent — returns existing primary', async () => {
    const u = await users.findOrCreateByPrivyDid(`did:privy:test-${Date.now()}`, {});
    const first = await provisioner.provisionPrimary(u.id);
    const second = await provisioner.provisionPrimary(u.id);
    expect(second.id).toBe(first.id);
    expect(second.privyWalletId).toBe(first.privyWalletId);
  });
});
