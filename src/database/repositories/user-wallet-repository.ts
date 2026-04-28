import type { UserWallet } from '../types';

export interface UserWalletRepository {
  insert(uw: UserWallet): Promise<void>;
  findById(id: string): Promise<UserWallet | null>;
  findPrimaryByUser(userId: string): Promise<UserWallet | null>;
  listByUser(userId: string): Promise<UserWallet[]>;
  findByPrivyWalletId(privyWalletId: string): Promise<UserWallet | null>;
}
