import type { AgentConfig } from '../types';

export interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  listByUser(userId: string): Promise<AgentConfig[]>;
  findById(id: string): Promise<AgentConfig | null>;
  upsert(agent: AgentConfig): Promise<void>;
  delete(id: string): Promise<void>;
}
