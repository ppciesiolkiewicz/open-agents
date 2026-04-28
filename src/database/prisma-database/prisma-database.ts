import type { PrismaClient } from '@prisma/client';
import type { Database } from '../database';
import type { AgentRepository } from '../repositories/agent-repository';
import type { TransactionRepository } from '../repositories/transaction-repository';
import type { PositionRepository } from '../repositories/position-repository';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import { PrismaAgentRepository } from './prisma-agent-repository';
import { PrismaTransactionRepository } from './prisma-transaction-repository';
import { PrismaPositionRepository } from './prisma-position-repository';
import { PrismaAgentMemoryRepository } from './prisma-agent-memory-repository';
import { PrismaActivityLogRepository } from './prisma-activity-log-repository';

export class PrismaDatabase implements Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
  readonly activityLog: ActivityLogRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.agents = new PrismaAgentRepository(prisma);
    this.transactions = new PrismaTransactionRepository(prisma);
    this.positions = new PrismaPositionRepository(prisma);
    this.agentMemory = new PrismaAgentMemoryRepository(prisma);
    this.activityLog = new PrismaActivityLogRepository(prisma);
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
