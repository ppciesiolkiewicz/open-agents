import type { AgentActivityLogEntry, AgentActivityLogEntryInput } from './types';

export interface ActivityLogStore {
  append(entry: AgentActivityLogEntryInput): Promise<void>;
  listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]>;
}
