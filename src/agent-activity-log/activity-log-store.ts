import type { AgentActivityLogEntry } from './types';

export interface ActivityLogStore {
  append(entry: AgentActivityLogEntry): Promise<void>;
  listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]>;
}
