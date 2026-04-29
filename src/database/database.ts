import type { AgentRepository } from './repositories/agent-repository';
import type { TransactionRepository } from './repositories/transaction-repository';
import type { PositionRepository } from './repositories/position-repository';
import type { AgentMemoryRepository } from './repositories/agent-memory-repository';
import type { ActivityLogRepository } from './repositories/activity-log-repository';
import type { UserRepository } from './repositories/user-repository';
import type { UserWalletRepository } from './repositories/user-wallet-repository';
import type { ZeroGPurchaseRepository } from './repositories/zero-g-purchase-repository';

export interface Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;
  readonly users: UserRepository;
  readonly userWallets: UserWalletRepository;
  readonly zeroGPurchases: ZeroGPurchaseRepository;
}
