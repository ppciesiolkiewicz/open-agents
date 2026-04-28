export type AgentActivityLogEntryType =
  | 'user_message'
  | 'tick_start'
  | 'tick_end'
  | 'tool_call'
  | 'tool_result'
  | 'llm_call'
  | 'llm_response'
  | 'memory_update'
  | 'error';

export interface AgentActivityLogEntryInput {
  agentId: string;
  tickId: string;
  timestamp: number;
  type: AgentActivityLogEntryType;
  payload: Record<string, unknown>;
}

export interface AgentActivityLogEntry extends AgentActivityLogEntryInput {
  seq: number;
}
