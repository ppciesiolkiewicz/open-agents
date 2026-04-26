import type { Transaction } from '../types';

export interface TransactionRepository {
  insert(tx: Transaction): Promise<void>;
  findById(id: string): Promise<Transaction | null>;
  listByAgent(agentId: string, opts?: { limit?: number }): Promise<Transaction[]>;
  updateStatus(
    id: string,
    patch: Pick<Transaction, 'status' | 'blockNumber' | 'hash'>,
  ): Promise<void>;
}
