import type { AgentRepository } from './repositories/agent-repository';
import type { TransactionRepository } from './repositories/transaction-repository';
import type { PositionRepository } from './repositories/position-repository';
import type { AgentMemoryRepository } from './repositories/agent-memory-repository';

export interface Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;
}
