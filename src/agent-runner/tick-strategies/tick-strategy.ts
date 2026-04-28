import type { AgentConfig, AgentMemory } from '../../database/types';
import type { ChatMessage } from '../llm-client';

export interface TickStrategyContext {
  agent: AgentConfig;
  memory: AgentMemory;
  systemPrompt: string;
  tickId: string;
}

export interface TickStrategy {
  buildInitialMessages(ctx: TickStrategyContext): Promise<ChatMessage[]>;
}
