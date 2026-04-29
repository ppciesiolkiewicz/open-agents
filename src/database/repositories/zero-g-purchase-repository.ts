import type { ZeroGPurchase } from '../types.js';

export interface ZeroGPurchaseRepository {
  insert(purchase: ZeroGPurchase): Promise<void>;
  findById(id: string): Promise<ZeroGPurchase | null>;
  findByIncomingTxHash(txHash: string): Promise<ZeroGPurchase | null>;
  listByUser(userId: string): Promise<ZeroGPurchase[]>;
  update(id: string, patch: Partial<Omit<ZeroGPurchase, 'id' | 'userId' | 'createdAt'>>): Promise<void>;
}
