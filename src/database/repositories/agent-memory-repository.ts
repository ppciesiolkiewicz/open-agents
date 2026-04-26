import type { AgentMemory } from '../types';

export interface AgentMemoryRepository {
  get(agentId: string): Promise<AgentMemory | null>;
  upsert(memory: AgentMemory): Promise<void>;
}
