import { randomUUID } from 'node:crypto';
import type { PrivyClient } from '@privy-io/server-auth';
import type { UserWalletRepository } from '../../database/repositories/user-wallet-repository';
import type { UserWallet } from '../../database/types';

export class WalletProvisioner {
  constructor(
    private readonly privy: PrivyClient,
    private readonly userWallets: UserWalletRepository,
  ) {}

  async provisionPrimary(userId: string): Promise<UserWallet> {
    const existing = await this.userWallets.findPrimaryByUser(userId);
    if (existing) return existing;

    const created = await this.privy.walletApi.create({ chainType: 'ethereum' });

    const uw: UserWallet = {
      id: randomUUID(),
      userId,
      privyWalletId: created.id,
      walletAddress: created.address,
      isPrimary: true,
      createdAt: Date.now(),
    };
    await this.userWallets.insert(uw);
    return uw;
  }
}
