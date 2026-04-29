import type { PrivyClient } from '@privy-io/server-auth';
import type { PublicClient } from 'viem';
import type { Wallet } from '../wallet';
import type { UserWallet } from '../../database/types';
import { PrivyServerWallet } from './privy-server-wallet';

export class PrivyWalletFactory {
  constructor(
    private readonly privy: PrivyClient,
    private readonly publicClient: PublicClient,
  ) {}

  forUserWallet(uw: UserWallet): Wallet {
    return new PrivyServerWallet(this.privy, uw, this.publicClient);
  }
}
