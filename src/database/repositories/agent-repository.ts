import type { AgentConfig } from '../types';

export interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  findById(id: string): Promise<AgentConfig | null>;
  upsert(agent: AgentConfig): Promise<void>;
}
