import type { ZeroGPurchase, ZeroGPurchaseStatus } from '../types.js';

export interface ZeroGPurchaseRepository {
  insert(purchase: ZeroGPurchase): Promise<void>;
  findById(id: string): Promise<ZeroGPurchase | null>;
  findByIncomingTxHash(txHash: string): Promise<ZeroGPurchase | null>;
  listByUser(userId: string, filter?: { statuses?: ZeroGPurchaseStatus[] }): Promise<ZeroGPurchase[]>;
  update(
    id: string,
    patch: Partial<Omit<ZeroGPurchase, 'id' | 'userId' | 'userWalletAddress' | 'incomingTxHash' | 'incomingUsdcAmount' | 'serviceFeeUsdcAmount' | 'swapInputUsdcAmount' | 'createdAt'>>
  ): Promise<void>;
}
