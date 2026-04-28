import type { ActivityLogStore } from './activity-log-store';
import type { AgentActivityLogEntry, AgentActivityLogEntryType } from './types';

export class AgentActivityLog {
  constructor(private readonly store: ActivityLogStore) {}

  userMessage(
    agentId: string,
    tickId: string,
    payload: { content: string },
  ): Promise<void> {
    return this.write(agentId, tickId, 'user_message', payload);
  }

  tickStart(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_start', payload);
  }

  tickEnd(agentId: string, tickId: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.write(agentId, tickId, 'tick_end', payload);
  }

  toolCall(
    agentId: string,
    tickId: string,
    payload: { id: string; tool: string; input: unknown },
  ): Promise<void> {
    return this.write(agentId, tickId, 'tool_call', payload);
  }

  toolResult(
    agentId: string,
    tickId: string,
    payload: { id: string; tool: string; output: unknown; durationMs: number },
  ): Promise<void> {
    return this.write(agentId, tickId, 'tool_result', payload);
  }

  llmCall(
    agentId: string,
    tickId: string,
    payload: { model: string; promptChars: number },
  ): Promise<void> {
    return this.write(agentId, tickId, 'llm_call', payload);
  }

  llmResponse(
    agentId: string,
    tickId: string,
    payload: {
      model: string;
      responseChars: number;
      tokenCount?: number;
      content: string;
      toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
    },
  ): Promise<void> {
    return this.write(agentId, tickId, 'llm_response', payload);
  }

  memoryUpdate(
    agentId: string,
    tickId: string,
    payload: {
      tool: 'updateMemory' | 'saveMemoryEntry';
      keysChanged: string[];
      state?: Record<string, unknown>;
      appendNote?: string;
      entry?: { type: string; content: string; parentEntryIds?: string[] };
    },
  ): Promise<void> {
    return this.write(agentId, tickId, 'memory_update', payload);
  }

  error(
    agentId: string,
    tickId: string,
    payload: { message: string; stack?: string; tool?: string },
  ): Promise<void> {
    return this.write(agentId, tickId, 'error', payload);
  }

  list(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]> {
    return this.store.listByAgent(agentId, opts);
  }

  private write(
    agentId: string,
    tickId: string,
    type: AgentActivityLogEntryType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.store.append({
      agentId,
      tickId,
      timestamp: Date.now(),
      type,
      payload,
    });
  }
}
