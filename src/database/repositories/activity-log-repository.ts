import type {
  AgentActivityLogEntry,
  AgentActivityLogEntryInput,
} from '../types';

export interface ActivityLogRepository {
  append(entry: AgentActivityLogEntryInput): Promise<AgentActivityLogEntry>;
  listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]>;
}
