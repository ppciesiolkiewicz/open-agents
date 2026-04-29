import type { PrismaClient } from '@prisma/client';
import type { Database } from '../database';
import type { AgentRepository } from '../repositories/agent-repository';
import type { TransactionRepository } from '../repositories/transaction-repository';
import type { PositionRepository } from '../repositories/position-repository';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import type { UserRepository } from '../repositories/user-repository';
import type { UserWalletRepository } from '../repositories/user-wallet-repository';
import type { ZeroGPurchaseRepository } from '../repositories/zero-g-purchase-repository';
import { PrismaAgentRepository } from './prisma-agent-repository';
import { PrismaTransactionRepository } from './prisma-transaction-repository';
import { PrismaPositionRepository } from './prisma-position-repository';
import { PrismaAgentMemoryRepository } from './prisma-agent-memory-repository';
import { PrismaActivityLogRepository } from './prisma-activity-log-repository';
import { PrismaUserRepository } from './prisma-user-repository';
import { PrismaUserWalletRepository } from './prisma-user-wallet-repository';
import { PrismaZeroGPurchaseRepository } from './prisma-zero-g-purchase-repository';

export class PrismaDatabase implements Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;
  readonly users: UserRepository;
  readonly userWallets: UserWalletRepository;
  readonly zeroGPurchases: ZeroGPurchaseRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.agents = new PrismaAgentRepository(prisma);
    this.transactions = new PrismaTransactionRepository(prisma);
    this.positions = new PrismaPositionRepository(prisma);
    this.agentMemory = new PrismaAgentMemoryRepository(prisma);
    this.activityLog = new PrismaActivityLogRepository(prisma);
    this.users = new PrismaUserRepository(prisma);
    this.userWallets = new PrismaUserWalletRepository(prisma);
    this.zeroGPurchases = new PrismaZeroGPurchaseRepository(prisma);
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
