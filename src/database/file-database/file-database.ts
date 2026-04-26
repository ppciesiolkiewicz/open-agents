import type { Database } from '../database';
import type { AgentRepository } from '../repositories/agent-repository';
import type { TransactionRepository } from '../repositories/transaction-repository';
import type { PositionRepository } from '../repositories/position-repository';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import { FileAgentRepository } from './file-agent-repository';
import { FileTransactionRepository } from './file-transaction-repository';
import { FilePositionRepository } from './file-position-repository';
import { FileAgentMemoryRepository } from './file-agent-memory-repository';

export class FileDatabase implements Database {
  readonly agents: AgentRepository;
  readonly transactions: TransactionRepository;
  readonly positions: PositionRepository;
  readonly agentMemory: AgentMemoryRepository;

  constructor(dbDir: string) {
    this.agents = new FileAgentRepository(dbDir);
    this.transactions = new FileTransactionRepository(dbDir);
    this.positions = new FilePositionRepository(dbDir);
    this.agentMemory = new FileAgentMemoryRepository(dbDir);
  }
}
